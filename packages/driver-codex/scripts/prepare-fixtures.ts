// 自分で採取した検証専用の記録から、パスと ID を匿名化する。認証の通信は入力に含めない。
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverEvent } from '@agentpwa/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'fixtures'), { recursive: true });
for (const name of ['approval', 'question', 'interrupt']) {
  const text = await readFile(path.join(root, '.local', 'recordings', `${name}.jsonl`), 'utf8');
  const ids = new Map<string, string>();
  const events = text.trim().split('\n').map((line) => JSON.parse(line) as DriverEvent);
  const clean = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => clean(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    if (typeof value !== 'string') return value;
    if (['messageId', 'toolId', 'token'].includes(key)) {
      if (!ids.has(value)) ids.set(value, `${name}-${key}-${ids.size + 1}`);
      return ids.get(value);
    }
    return value
      .replace(/C:\\Users\\[^\\]+\\Documents\\AgentPWA\\packages\\driver-codex\\\.local\\scenarios\\\d+\\/g, '')
      .replace(/C:\\Users\\[^\\]+\\Documents\\AgentPWA\\packages\\driver-codex\\\.local\\scenarios\\\d+/g, '<作業フォルダ>')
      .replace(/"C:\\\\Program Files\\\\WindowsApps\\\\[^"\n]+\\\\pwsh\.exe"/g, 'pwsh');
  };
  await writeFile(path.join(root, 'fixtures', `${name}.jsonl`), events.map((e) => JSON.stringify(clean(e))).join('\n') + '\n');
}
