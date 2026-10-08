#!/usr/bin/env python3
"""Exercise ModBridge's actual desktop IPC and Vue UI in a network namespace.

Run after building the frontend and native binary. Activate the cached native
libraries and WebKit overlay, then run this inside scripts/relay-only.py or a
loopback-only namespace with dbus-run-session. No external Python packages are
required. Fixture accounts, settings, groups, and skins use isolated app data.
"""

import argparse
import base64
import importlib.util
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import tempfile
import zlib
from pathlib import Path

class Inspector:
	def __init__(self, path, port):
		self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
		key = base64.b64encode(os.urandom(16)).decode()
		self.sock.sendall(f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
		response = b''
		while not response.endswith(b'\r\n\r\n'):
			response += self.sock.recv(1)
		if not response.startswith(b'HTTP/1.1 101'):
			raise RuntimeError('Inspector WebSocket upgrade failed')
		self.ident = 0
		self.target_id = None
		while self.target_id is None:
			message = self.receive()
			if message.get('method') == 'Target.targetCreated':
				self.target_id = message['params']['targetInfo']['targetId']
	def read(self, size):
		result = b''
		while len(result) < size:
			chunk = self.sock.recv(size - len(result))
			if not chunk:
				raise EOFError('Inspector closed')
			result += chunk
		return result
	def send(self, payload, opcode=1):
		data = payload.encode() if isinstance(payload, str) else payload
		length = len(data)
		header = bytes([0x80 | opcode, 0x80 | min(length, 126)])
		if length >= 126:
			header += struct.pack('!H', length)
		mask = os.urandom(4)
		self.sock.sendall(header + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))
	def receive(self):
		first, second = self.read(2)
		opcode = first & 15
		length = second & 127
		if length == 126:
			length = struct.unpack('!H', self.read(2))[0]
		elif length == 127:
			length = struct.unpack('!Q', self.read(8))[0]
		mask = self.read(4) if second & 128 else None
		data = self.read(length)
		if mask:
			data = bytes(x ^ mask[i % 4] for i, x in enumerate(data))
		if opcode == 9:
			self.send(data, 10)
			return self.receive()
		if opcode == 8:
			raise EOFError('Inspector closed')
		return json.loads(data)
	def call(self, method, params=None):
		self.ident += 1
		outer_id = self.ident + 100000
		message = json.dumps({'id':self.ident,'method':method,'params':params or {}})
		self.send(json.dumps({'id':outer_id,'method':'Target.sendMessageToTarget','params':{'targetId':self.target_id,'message':message}}))
		while True:
			response = self.receive()
			if response.get('id') == outer_id and 'error' in response:
				raise RuntimeError(response['error'])
			if response.get('method') == 'Target.dispatchMessageFromTarget':
				response = json.loads(response['params']['message'])
				if response.get('id') == self.ident:
					if 'error' in response:
						raise RuntimeError(response['error'])
					return response['result']
	def evaluate(self, expression):
		result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True})
		if result.get('wasThrown'):
			raise RuntimeError(result['result'])
		return result['result'].get('value')
	def run(self, body, timeout=20):
		expression = 'window.__modbridgeSmokeResult = null; (async () => {' + body + '})().then(result => window.__modbridgeSmokeResult = {ok:true,result}).catch(error => window.__modbridgeSmokeResult = {ok:false,error:JSON.stringify({message:error?.message || String(error)})}); "started"'
		self.evaluate(expression)
		for _ in range(int(timeout * 10)):
			result = self.evaluate('window.__modbridgeSmokeResult')
			if result is not None:
				if not result['ok']:
					raise RuntimeError(result['error'])
				return result['result']
			time.sleep(0.1)
		raise TimeoutError('Native smoke command timed out')

def skin_fixture():
	def chunk(kind, data):
		return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
	pixels = (b'\0' + bytes([32, 96, 64, 255]) * 64) * 64
	return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 64, 64, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--binary', type=Path, default=Path(__file__).resolve().parents[1] / 'target/debug/theseus_gui')
	parser.add_argument('--data-dir', type=Path)
	parser.add_argument('--log', type=Path, default=Path('/tmp/modbridge-desktop-smoke.log'))
	parser.add_argument('--screenshot', type=Path)
	parser.add_argument('--ipc-only', action='store_true')
	parser.add_argument('--probe-relay', action='store_true')
	parser.add_argument('--launcher-fixture', action='store_true')
	parser.add_argument('--expected-entry', help='Built frontend entry filename expected inside the native binary')
	parser.add_argument('--display', default=':96')
	parser.add_argument('--inspector-port', type=int, default=2999)
	args = parser.parse_args()
	if {name for _, name in socket.if_nameindex()} != {'lo'}:
		parser.error('Run desktop tests inside scripts/relay-only.py or a loopback-only namespace')
	if not args.binary.is_file():
		parser.error(f'Native binary is missing: {args.binary}')
	temporary_data = tempfile.TemporaryDirectory(prefix='modbridge-desktop-smoke-') if args.data_dir is None else None
	data_dir = args.data_dir or Path(temporary_data.name)
	data_dir.mkdir(parents=True, exist_ok=True)
	if any(data_dir.iterdir()):
		parser.error('Use an empty fixture data directory; existing app data is never tested in place')
	launcher_fixture = None
	fixture_module = None
	if args.launcher_fixture:
		sys.dont_write_bytecode = True
		spec = importlib.util.spec_from_file_location('modbridge_launcher_fixture', Path(__file__).with_name('launcher-fixture.py'))
		fixture_module = importlib.util.module_from_spec(spec)
		spec.loader.exec_module(fixture_module)
		launcher_fixture = fixture_module.prepare_runtime_fixture(data_dir)
	smoke_env = os.environ.copy()
	smoke_env.update(DISPLAY=args.display, WEBKIT_DISABLE_COMPOSITING_MODE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1', WEBKIT_INSPECTOR_HTTP_SERVER=f'127.0.0.1:{args.inspector_port}', THESEUS_CONFIG_DIR=str(data_dir), MODBRIDGE_CONFIG_DIR=str(data_dir), XDG_DATA_HOME=str(data_dir / 'desktop-data'), XDG_CACHE_HOME=str(data_dir / 'desktop-cache'), RUST_LOG='info')
	with args.log.open('w') as log:
		xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], env=smoke_env, stdout=log, stderr=log)
		app = None
		try:
			for _ in range(20):
				if subprocess.run(['xdpyinfo', '-display', args.display], env=smoke_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
					break
				time.sleep(0.1)
			app = subprocess.Popen([str(args.binary)], env=smoke_env, stdout=log, stderr=log)
			target = None
			for _ in range(50):
				try:
					listing = urllib.request.urlopen(f'http://127.0.0.1:{args.inspector_port}/', timeout=1).read().decode()
					match = re.search(r'/socket/\d+/\d+/WebPage', listing)
					if match:
						target = match.group(0)
						break
				except (OSError, urllib.error.URLError):
					pass
				if app.poll() is not None:
					raise RuntimeError(f'App exited {app.returncode}')
				time.sleep(0.2)
			if target is None:
				raise RuntimeError('No WebKit inspectable target')
			inspector = Inspector(target, args.inspector_port)
			inspector.call('Runtime.enable')
			for _ in range(100):
				if inspector.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke && document.getElementById("app").__vue_app__ && document.querySelector(".app-contents"))'):
					break
				time.sleep(0.1)
			entries = inspector.evaluate('[...document.querySelectorAll("script[src]")].map(script=>script.getAttribute("src"))')
			print('NATIVE_FRONTEND_ENTRIES', json.dumps(entries), flush=True)
			if args.expected_entry and not any(args.expected_entry in entry for entry in entries):
				raise RuntimeError(f'Native binary does not embed expected frontend entry {args.expected_entry}')
			if launcher_fixture:
				inspector.run("for(let i=0;i<100;i++){try{await window.__TAURI_INTERNALS__.invoke('plugin:auth|get_users');return true}catch{await new Promise(r=>setTimeout(r,100))}}throw new Error('State did not initialize')")
				fixture_module.seed_runtime_cache(data_dir, launcher_fixture)
			inspector.evaluate('window.__modbridgeLauncherFixture = ' + json.dumps(launcher_fixture))
			if args.probe_relay:
				print('WEBVIEW_RELAY_PROBE_START', flush=True)
				probe = inspector.run("""
					const relay='https://br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech';
					const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),4000);
					const fetchProbe=fetch(relay+'/health?desktop-proxy-smoke',{signal:controller.signal}).then(r=>({status:r.status})).catch(()=>({blocked:true})).finally(()=>clearTimeout(timer));
					const imageProbe=new Promise(resolve=>{const image=new Image();const done=result=>{clearTimeout(timeout);resolve(result)};const timeout=setTimeout(()=>done({timeout:true}),4000);image.onload=()=>done({loaded:true});image.onerror=()=>done({blocked:true});image.src=relay+'/launcher-files/assets/steve_head.png?desktop-proxy-smoke'});
					const websocketProbe=new Promise(resolve=>{const socket=new WebSocket(relay.replace('https:','wss:')+'/api/_internal/launcher_socket');const done=result=>{clearTimeout(timeout);try{socket.close()}catch{}resolve(result)};const timeout=setTimeout(()=>done({timeout:true}),4000);socket.onopen=()=>done({opened:true});socket.onerror=()=>done({blocked:true})});
					return {fetch:await fetchProbe,image:await imageProbe,websocket:await websocketProbe};
				""")
				print('WEBVIEW_RELAY_PROBE', json.dumps(probe), flush=True)
			inspector.evaluate('window.__modbridgeSmokeTexture = ' + json.dumps(list(skin_fixture())))
			if not args.ipc_only:
				first_profile = inspector.run("""
					const invoke=window.__TAURI_INTERNALS__.invoke;
					const assert=(condition,message)=>{if(!condition)throw new Error(message)};
					let username,pin;
					for(let i=0;i<100;i++) {
						username=document.querySelector('input[placeholder*="Player name"]');
						pin=document.querySelector('input[placeholder*="Identity PIN"]');
						if(username?.offsetParent && pin?.offsetParent)break;
						await new Promise(r=>setTimeout(r,100));
					}
					assert(username?.offsetParent && pin?.offsetParent, 'First offline profile form is visible');
					username.value='UiSmokeProfile';username.dispatchEvent(new Event('input',{bubbles:true}));
					pin.value=' ';pin.dispatchEvent(new Event('input',{bubbles:true}));
					await new Promise(r=>setTimeout(r,100));
					const create=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim().toLowerCase()==='create offline profile').at(-1);
					assert(create?.disabled, 'Empty identity PIN cannot submit');
					pin.value='1357';pin.dispatchEvent(new Event('input',{bubbles:true}));
					username.value='invalid name';username.dispatchEvent(new Event('input',{bubbles:true}));
					await new Promise(r=>setTimeout(r,100));create.click();
					await new Promise(r=>setTimeout(r,100));
					assert(document.body.innerText.includes('letters, numbers, or underscores'), 'Invalid username error shown in UI');
					assert((await invoke('plugin:auth|get_users')).length===0, 'Invalid username does not create account');
					username.value='UiSmokeProfile';username.dispatchEvent(new Event('input',{bubbles:true}));
					await new Promise(r=>setTimeout(r,100));
					assert(create && !create.disabled, 'Create offline profile button is enabled');
					create.click();
					let created;
					for(let i=0;i<100;i++) {created=(await invoke('plugin:auth|get_users')).find(a=>a.profile.name==='UiSmokeProfile');if(created)break;await new Promise(r=>setTimeout(r,100))}
					assert(created, 'First offline profile creates through UI');
					assert(await invoke('plugin:auth|get_default_user')===created.profile.id, 'First UI profile is default');
					await new Promise(r=>setTimeout(r,400));
					const account=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('UiSmokeProfile'));
					assert(account, 'Created account shown in UI');account.click();
					await new Promise(r=>setTimeout(r,300));
					const remove=document.querySelector('button[aria-label="Remove account"]');
					assert(remove, 'Remove account button exists');remove.click();
					for(let i=0;i<100 && (await invoke('plugin:auth|get_users')).length;i++)await new Promise(r=>setTimeout(r,100));
					assert((await invoke('plugin:auth|get_users')).length===0, 'Account deletes through UI');
					return {firstOfflineProfileCreate:true,usernameErrorShown:true,emptyPinCannotSubmit:true,defaultSelected:true,profileUiDelete:true};
				""", timeout=40)
				print('FIRST_PROFILE_UI', json.dumps(first_profile), flush=True)
			result = inspector.run('''
				const invoke = window.__TAURI_INTERNALS__.invoke;
				const assert = (condition, message) => {if (!condition) throw new Error(message)};
				for (let i=0;i<100;i++) {
					try {await invoke('plugin:auth|get_users'); break} catch {await new Promise(r=>setTimeout(r,100))}
				}
				let invalidName=false;
				try {await invoke('plugin:auth|add_offline_user',{username:'invalid name',pin:'1234'})} catch(e) {invalidName=Boolean(e.message)}
				assert(invalidName, 'Username validation error reaches IPC');
				let invalidPin=false;
				try {await invoke('plugin:auth|add_offline_user',{username:'ValidName',pin:''})} catch(e) {invalidPin=Boolean(e.message)}
				assert(invalidPin, 'PIN validation error reaches IPC');
				const first = await invoke('plugin:auth|add_offline_user', {username:'RelaySmokeOne',pin:'test-secret-one'});
				const second = await invoke('plugin:auth|add_offline_user', {username:'RelaySmokeTwo',pin:'test-secret-two'});
				assert(first.profile.name === 'RelaySmokeOne' && second.profile.name === 'RelaySmokeTwo', 'Offline identity name');
				assert(first.profile.id !== second.profile.id, 'Distinct identity UUIDs');
				assert(!JSON.stringify([first,second]).includes('test-secret'), 'PIN must not reach IPC');
				await invoke('plugin:auth|set_default_user', {user:first.profile.id});
				assert(await invoke('plugin:auth|get_default_user') === first.profile.id, 'First default account');
				await invoke('plugin:auth|set_default_user', {user:second.profile.id});
				assert(await invoke('plugin:auth|get_default_user') === second.profile.id, 'Default account switch');
				await invoke('plugin:auth|remove_user', {user:second.profile.id});
				assert(await invoke('plugin:auth|get_default_user') === first.profile.id, 'Default account fallback');
				let launchFixture=false;
				const fixture=window.__modbridgeLauncherFixture;
				if (fixture) {
					const javaVersion=await invoke('plugin:jre|jre_get_jre',{path:fixture.java_path});
					assert(javaVersion, 'Cached Java runtime detected');
					await invoke('plugin:jre|set_java_version',{javaVersion});
					let job=await invoke('plugin:install|install_create_instance',{request:{name:fixture.instance_name,gameVersion:fixture.game_version,loader:'vanilla'}});
					for(let i=0;i<300 && !['succeeded','failed','canceled','interrupted'].includes(job.status);i++) {
						await new Promise(r=>setTimeout(r,100));
						job=await invoke('plugin:install|install_job_get',{jobId:job.job_id});
					}
					assert(job.status==='succeeded','Cached instance install: '+JSON.stringify(job.error || job.status));
					const instanceId=job.instance_id;
					assert(instanceId, 'Installed instance ID');
					await invoke('plugin:instance|instance_edit',{instanceId,editInstance:{extra_launch_args:['-Dmodbridge.fixture.username='+first.profile.name,'-Dmodbridge.fixture.uuid='+first.profile.id.replaceAll('-','')],memory:{maximum:256}}});
					const saved=await invoke('plugin:instance|instance_get',{instanceId});
					assert(saved?.memory?.maximum===256 && saved.extra_launch_args.length===2,'Instance launch settings persisted');
					try {
						await invoke('plugin:instance|instance_run',{instanceId,serverAddress:null});
						let output='';
						for(let i=0;i<150;i++) {
							output=await invoke('plugin:logs|logs_get_live_log_buffer',{instanceId});
							if(['IDENTITY_OK','RPC_OK','STDERR_OK'].every(marker=>output.includes('MODBRIDGE_FIXTURE_'+marker)))break;
							await new Promise(r=>setTimeout(r,100));
						}
						assert(output.includes('MODBRIDGE_FIXTURE_IDENTITY_OK'),'Offline username/UUID/token/user type verified by launched Java client: '+output.slice(-2400));
						assert(output.includes('MODBRIDGE_FIXTURE_RPC_OK'),'RPC launcher injected instance properties');
						assert(output.includes('MODBRIDGE_FIXTURE_STDERR_OK'),'Live stderr captured');
						assert((await invoke('plugin:process|process_get_by_instance_id',{instanceId})).length===1,'Launched process tracked');
					} finally {await invoke('plugin:instance|instance_kill',{instanceId})}
					for(let i=0;i<100 && (await invoke('plugin:process|process_get_by_instance_id',{instanceId})).length;i++)await new Promise(r=>setTimeout(r,100));
					assert((await invoke('plugin:process|process_get_by_instance_id',{instanceId})).length===0,'Process stops through native launcher');
					await invoke('plugin:instance|instance_edit',{instanceId,editInstance:{name:'Renamed native launch smoke'}});
					assert((await invoke('plugin:instance|instance_get',{instanceId})).name==='Renamed native launch smoke','Instance rename persisted');
					await invoke('plugin:instance|instance_remove',{instanceId});
					assert(await invoke('plugin:instance|instance_get',{instanceId})===null,'Fixture instance removed');
					launchFixture={cachedInstall:true,offlineIdentityLaunch:true,rpcProperties:true,stdoutAndStderr:true,processTrackingAndStop:true,instanceSettingsRenameRemove:true};
				}
				const skins = await invoke('plugin:minecraft-skins|get_available_skins');
				assert(skins.length > 0, 'Bundled skins remain available offline');
				const capeList = await invoke('plugin:minecraft-skins|get_available_capes');
				assert(capeList.length === 0, 'Offline cape list');
				const normalized = await invoke('plugin:minecraft-skins|normalize_skin_texture', {texture:window.__modbridgeSmokeTexture});
				assert(normalized.length > 0 && normalized[0] === 137, 'Local PNG import');
				const importedSkin = {...skins[0],texture_key:'native-smoke-texture',source:'custom',is_equipped:false};
				const savedSkin = await invoke('plugin:minecraft-skins|save_custom_skin', {skin:importedSkin,textureBlob:normalized,variant:'CLASSIC',cape:null,replaceTexture:true});
				assert((await invoke('plugin:minecraft-skins|get_available_skins')).some(s=>s.texture_key===savedSkin.texture_key), 'Local skin save');
				let onlineSkinBlocked=false;
				try {await invoke('plugin:minecraft-skins|equip_skin', {skin:savedSkin})} catch(e) {onlineSkinBlocked=String(e.message || e).includes('save and preview')}
				assert(onlineSkinBlocked, 'Offline skin apply fails before network');
				await invoke('plugin:minecraft-skins|remove_custom_skin', {skin:savedSkin});
				assert(!(await invoke('plugin:minecraft-skins|get_available_skins')).some(s=>s.texture_key===savedSkin.texture_key), 'Local skin remove');
				await invoke('plugin:auth|remove_user', {user:first.profile.id});
				assert((await invoke('plugin:auth|get_users')).length === 0, 'Accounts remove');
				const settings = await invoke('plugin:settings|settings_get');
				await invoke('plugin:settings|settings_set', {settings:{...settings,theme:'light'}});
				assert((await invoke('plugin:settings|settings_get')).theme === 'light', 'Settings save');
				await invoke('plugin:settings|settings_set', {settings});
				const group = await invoke('plugin:instance|instance_create_group', {name:'Native smoke library group'});
				await invoke('plugin:instance|instance_rename_group', {id:group.id,newName:'Renamed native smoke group'});
				assert((await invoke('plugin:instance|instance_list_groups')).some(g=>g.id === group.id && g.name === 'Renamed native smoke group'), 'Library group edit');
				await invoke('plugin:instance|instance_delete_group', {id:group.id});
				assert(!(await invoke('plugin:instance|instance_list_groups')).some(g=>g.id === group.id), 'Library group remove');
				const checklist = await invoke('plugin:onboarding-checklist|get_onboarding_checklist');
				try {
					await invoke('plugin:ads|init_ads_window');
					assert(await invoke('plugin:ads|should_show_ads_consent_popup') === false, 'Ads remain disabled');
				} catch(e) {assert(String(e).includes('plugin ads not found'), 'Ads command failure')}
				const webviews = await invoke('plugin:webview|get_all_webviews');
				assert(!webviews.some(w=>w.label === 'ads-window'), 'No external ads webview');
				let microsoftBlocked=false;
				try {await invoke('plugin:auth|login')} catch(e) {microsoftBlocked=String(e.message || e).includes('Relay')}
				assert(microsoftBlocked, 'Microsoft native webview blocked');
				let unsupportedDownloadBlocked=false;
				try {await invoke('plugin:files|download_file_to_user_destination',{url:'https://example.invalid/backup.zip',name:'backup.zip'})} catch(e) {unsupportedDownloadBlocked=String(e.message || e).includes('Relay does not support requests')}
				assert(unsupportedDownloadBlocked, 'Native download command registered and rejects unsupported host before dialog/network');
				return {offlineIdentityCreate:true,defaultSwitchAndFallback:true,accountsDelete:true,pinRedacted:true,inputValidation:true,offlineSkinsReadable:true,localSkinImportSaveDelete:true,offlineSkinApplyBlocked:true,settingsPersistence:true,libraryGroupCrud:true,onboardingReadable:Boolean(checklist),adsDisabled:true,microsoftEmbeddedSignInBlocked:true,unsupportedDownloadBlocked:true,launchFixture};
			''', timeout=120)
			print('NATIVE_IPC', json.dumps(result), flush=True)
			if args.ipc_only:
				return
			ui = inspector.run('''
				const router = document.getElementById('app').__vue_app__.config.globalProperties.$router;
				const pages=[];
				for (const path of ['/', '/skins', '/screenshots']) {
					await router.push(path);
					await new Promise(r=>setTimeout(r,700));
					const text=document.body.innerText;
					const expected={'/':'Home','/skins':'Skin selector','/screenshots':'Screenshots'}[path];
					if(!text.includes(expected))throw new Error('Page did not render '+path);
					if(text.includes('Sign in to Minecraft') || text.includes('Sign in to Microsoft'))throw new Error('Offline UI still displays online Minecraft sign-in on '+path);
					if(path==='/skins' && (!text.includes('Create an offline profile to save and preview skins.') || text.includes('demo account') || text.includes('save and apply skins')))throw new Error('No-account skin copy does not match offline capabilities');
					pages.push({path,text:text.slice(0,800),rendered:true});
				}
				await router.push('/hosting/manage');
				await new Promise(r=>setTimeout(r,1000));
				const originalFetch=window.fetch;
				const browserRequests=[];
				window.fetch=(resource,options)=>{
					if(decodeURIComponent(String(resource)).includes('plugin:opener|open_url')) {
						browserRequests.push(JSON.parse(options.body));
						return Promise.resolve(new Response('null',{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}}));
					}
					return originalFetch(resource,options);
				};
				try {
					const newServer=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('New server in browser'));
					if(!newServer)throw new Error('Hosting browser purchase action missing: '+document.body.innerText.slice(-1500));
					newServer.click();
					for(let i=0;i<20 && !browserRequests.length;i++)await new Promise(r=>setTimeout(r,100));
					if(browserRequests.length!==1 || browserRequests[0].url!=='https://modrinth.com/hosting/manage')throw new Error('Hosting purchase browser handoff failed: '+JSON.stringify(browserRequests));
					if(document.querySelector('script[src*="stripe.com"],iframe[src*="stripe.com"]'))throw new Error('Desktop purchase embedded Stripe');
				} finally {window.fetch=originalFetch}
				await router.push('/');
				await new Promise(r=>setTimeout(r,500));
				const settingsButton = [...document.querySelectorAll('button.nav-button')].at(-1);
				if (!settingsButton) throw new Error('Settings button missing');
				settingsButton.click();
				await new Promise(r=>setTimeout(r,500));
				const text=document.body.innerText;
				if (!text.includes('Appearance')) throw new Error('Settings modal did not render');
				return {pages,hostingPurchaseBrowserHandoff:true,stripeEmbedsAbsent:true,settingsModalRendered:true,settingsModalText:text.slice(-2200)};
			''')
			print('NATIVE_UI', json.dumps(ui), flush=True)
			if args.screenshot:
				subprocess.run(['import', '-display', args.display, '-window', 'root', str(args.screenshot)], env=smoke_env, check=True)
		except Exception:
			try:
				print('NATIVE_FAILURE_UI', json.dumps(inspector.evaluate('({path:location.pathname,text:document.body.innerText.slice(0,1800),inputs:[...document.querySelectorAll("input")].map(input=>({placeholder:input.placeholder,visible:Boolean(input.offsetParent)}))})')), flush=True)
				if args.screenshot:
					subprocess.run(['import', '-display', args.display, '-window', 'root', str(args.screenshot)], env=smoke_env, check=True)
			except Exception:
				pass
			raise
		finally:
			for process in [app, xvfb]:
				if process is not None and process.poll() is None:
					process.terminate()
					process.wait(timeout=10)

if __name__ == '__main__':
	main()
