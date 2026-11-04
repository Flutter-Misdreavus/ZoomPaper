import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Windows Python installers normally provide `python`, while Unix uses python3.
const command = process.platform === 'win32' ? 'python' : 'python3';
const script = fileURLToPath(new URL('./package_browser_extension.py', import.meta.url));
const result = spawnSync(command, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error(`无法启动 ${command}，请先安装 Python 3：${result.error.message}`);
process.exit(result.status ?? 1);
