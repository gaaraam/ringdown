import { expect, it } from 'vitest';
import { messages, reportView } from '../web/render.js';
import { listPackDirs, loadPack } from '../src/pack/load.ts';
import { runCall } from '../src/runtime/call.ts';
import { RuleBrain } from '../src/brain/rule.ts';
import { runMatrix } from '../src/soundcheck/runner.ts';
import { resolveModels } from '../src/config/models.ts';
const loaded = loadPack(listPackDirs('packs')[0]);
if (!loaded.ok) throw new Error('fixture');

it('RuleBrain proposal rejected by runtime stays visibly rejected beside accepted fallback', async () => {
  const pack = structuredClone(loaded.value);
  // A deliberately bad rule proposes a forbidden tool; even RuleBrain is subject to guards.
  pack.pack.stages[0].rule.on.yes = { tool: 'not.allowed', say: '<script>bad</script>' };
  let state;
  let turns = 0;
  const customerSource = { spec: { speechRate: 7 }, reply: () => ++turns === 1 ? '네' : '전화하지 마세요', responseDelay: () => 300, interruption: () => undefined };
  const result = await runCall(pack, pack.personas[0], 'clean', 7, { brain: new RuleBrain(), customerSource, onState: s => { state = s; } });
  const rejection = result.events.find(e => e.type === 'guard.reject' && e.layer === 'control');
  expect(rejection).toBeDefined();
  const html = messages({ state, events: result.events, status: 'complete' }, { silenceMaxSec: pack.pack.policy.silenceMaxSec });
  expect(html).toContain('실행 거부된 제안');
  expect(html).toContain(rejection.reason);
  expect(html).toContain('이 제안은 실행하지 않았어요');
  expect(html).toContain('Brain 제안');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  const banner = html.indexOf('런타임이');
  expect(banner).toBeGreaterThan(0);
  expect(html.indexOf('<details', banner)).toBeGreaterThan(banner);
});
it('multi-seed heatmap uses goal success, and non-rate metrics have no invented CI', async () => {
  const { report } = await runMatrix(loaded.value, { faults: ['down'], seeds: [1, 7], models: resolveModels({ env: {} }), gitSha: 'test', runId: 'test' });
  const html = reportView(report);
  expect(html).toContain('Wilson 95% CI');
  expect(html).toContain('CI 없음');
  expect(html).toContain('성공 0%, 2통화 열기');
});
