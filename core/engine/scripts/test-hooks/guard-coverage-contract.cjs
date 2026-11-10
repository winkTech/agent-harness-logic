#!/usr/bin/env node
'use strict';

/**
 * guard-coverage-contract.cjs — 守卫覆盖率与受保护写入对账契约 (D9)。
 *
 * 锁定:
 *   1. bash-safety-guard 的每个危险模式类别都至少有一条真实 case 打到它
 *      (2026-07-30 首次运行报告 8/11 —— privilege-escalation / system-install /
 *       sql-destructive 三条防线写了但从未被验证过, 已补 case)
 *   2. 覆盖率判定必须来自**真实执行**返回的 category, 不是文本猜测
 *   3. protected-writes 对账规则: 无 reason 的放行=critical, 通配符令牌=high,
 *      过期令牌残留=medium; 一次性令牌被消费后审批文件为空属正常终态
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const guardCoverage = require(path.join(ROOT, 'engine/scripts/guard-coverage.cjs'));
const health = require(path.join(ROOT, 'engine/scripts/memory-health-check.cjs'));

function main() {
  // ── 1+2. 覆盖率: 每个类别都被真实 case 命中 ──
  const report = guardCoverage.coverage({});
  assert.ok(report.categories >= 11, `expected >=11 guard categories, got ${report.categories}`);
  assert.ok(report.casesExecuted >= 25, `expected >=25 executed bash-safety cases, got ${report.casesExecuted}`);
  assert.deepEqual(report.uncovered, [],
    `guard categories without a single covering case: ${report.uncovered.join(', ')}`);
  assert.equal(report.coverageRate, 1);
  for (const entry of report.perCategory) {
    // 两种实现都算合法防护: 正则表 (patterns 可数) 与 token 解析器
    // (protected-branch-push 判 refspec 目标分支, 没有可数条目)。
    assert.ok(['regex-table', 'parser'].includes(entry.kind), `${entry.category}: unknown kind ${entry.kind}`);
    if (entry.kind === 'regex-table') {
      assert.ok(entry.patterns > 0, `${entry.category}: pattern count must be counted from the guard source`);
    } else {
      assert.equal(entry.patterns, null, `${entry.category}: parser-based categories must not report a pattern count`);
    }
    assert.ok(entry.cases > 0, `${entry.category}: needs at least one executed case`);
  }

  // ── 3. protected-writes 对账三条规则 ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-coverage-'));
  try {
    const auditDir = path.join(tmp, 'var', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const auditFile = path.join(auditDir, 'protected-writes.jsonl');
    const approvalFile = path.join(auditDir, 'protected-write-approvals.json');

    // 正常终态: 有理由的放行 + 空审批文件 (令牌已被消费) → 无问题
    fs.writeFileSync(auditFile, `${JSON.stringify({
      ts: new Date().toISOString(), file: 'matlab/gm.m', pattern: '**/matlab/**', reason: '用户会话中批准',
    })}\n`, 'utf8');
    fs.writeFileSync(approvalFile, '[]', 'utf8');
    let metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.writes, 1);
    assert.equal(metrics.writesWithoutReason, 0,
      'a consumed one-time token must not be reported as an unapproved write');

    // 无 reason 的放行 → 必须被算成"无批准的写入"
    fs.appendFileSync(auditFile, `${JSON.stringify({
      ts: new Date().toISOString(), file: 'matlab/other.m', pattern: '**/matlab/**', reason: '  ',
    })}\n`, 'utf8');
    metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.writes, 2);
    assert.equal(metrics.writesWithoutReason, 1);

    // 通配符令牌 + 过期令牌
    fs.writeFileSync(approvalFile, JSON.stringify([
      { path: 'matlab/*.m', reason: 'wildcard', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      { path: 'matlab/expired.m', reason: 'stale', expiresAt: new Date(Date.now() - 3600_000).toISOString() },
    ]), 'utf8');
    metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.wildcardTokens, 1);
    assert.equal(metrics.expiredTokens, 1);
    assert.equal(metrics.liveTokens, 1);

    // 审计文件缺失时不得伪造数据
    const empty = health.queryProtectedWrites(path.join(tmp, 'nowhere'));
    assert.equal(empty.auditAvailable, false);
    assert.equal(empty.writes, 0);
    assert.equal(empty.writesWithoutReason, 0);

    // ── 4. 工具侧守卫覆盖率 ──
    // file-protection-guard 是 PreToolUse hook, 只拦 Edit/Write/MultiEdit。经 Bash 跑
    // 的脚本一律绕过它, 而命令文本里往往根本不出现路径 (只有 `--write`), 所以 hook 侧
    // 扫命令也拦不住 —— 唯一可靠的位置是写入方自己调 lib/protected-write.cjs。
    //
    // 2026-08-09 实测: 16 个会写文件的工具里只有 2 个调了它, 其中
    // **manifest-migrate.cjs 会原地重写全部 7 份受治理 golden 的 manifest, 却一道
    // 检查都没有** —— 比 manifest-hash-refresh 那道"无令牌即拒绝"还少。
    // 这个洞长期没被发现, 正是因为覆盖率从来没被当成判据。本节把它变成判据。
    //
    // 判定范围取"既遍历资产集、又写文件"的工具: 只有这类才可能把写落进 models/**。
    // 豁免必须写明理由, **且理由要由 check() 真跑一遍**, 免得日后数据变了理由还挂着。
    const toolsDir = path.join(ROOT, 'engineering-assets', 'tools');
    const { isProtected } = require(path.join(toolsDir, 'lib', 'protected-write.cjs'));
    const catalogGen = require(path.join(toolsDir, 'catalog-gen.cjs'));
    const EA = 'engineering-assets';

    const EXEMPT = {
      'manifest-render.cjs': {
        why: '只渲染 kind=rtl 资产的 README; 受保护资产全是 golden-model, 够不着。',
        check() {
          const rtl = catalogGen.scanRepository(EA).assets.filter((a) => a.kind === 'rtl');
          assert.ok(rtl.length > 0, 'manifest-render 豁免理由已失真: 扫不到任何 kind=rtl 资产');
          const hit = rtl.filter((a) => isProtected(path.join(EA, a.dir, 'README.md')));
          assert.deepEqual(hit.map((a) => a.dir), [],
            'manifest-render 豁免理由已失真: 有 kind=rtl 资产落在受保护区, 它会无守卫地写其 README');
        },
      },
      'catalog-gen.cjs': {
        why: '只写 catalog/ 下的生成物; 输出清单由 expectedFiles() 算出, 逐条查过不落受保护区。',
        check() {
          const scan = catalogGen.scanRepository(EA);
          const files = [...catalogGen.expectedFiles(scan).keys()];
          assert.ok(files.length > 0, 'catalog-gen 豁免理由已失真: 算不出任何输出文件');
          const hit = files.filter((rel) => isProtected(path.join(EA, rel)));
          assert.deepEqual(hit, [], 'catalog-gen 豁免理由已失真: 有输出文件落进受保护区');
        },
      },
      'knowledge-index.cjs': {
        why: '输出四个定死的路径 (catalog/ 两个 + knowledge/ 两个), 与资产目录无关。',
        check() {
          for (const rel of ['catalog/knowledge-index.json', 'catalog/KNOWLEDGE-INDEX.md',
            'knowledge/INDEX.md', 'knowledge/INDEX-FILES.md']) {
            assert.equal(isProtected(path.join(EA, rel)), false,
              `knowledge-index 豁免理由已失真: 输出路径 ${rel} 落进受保护区`);
          }
        },
      },
      'asset-audit.cjs': {
        why: '只写 var/audit/audit-report.json 一个报告文件。',
        check() {
          assert.equal(isProtected(path.join(EA, 'var/audit/audit-report.json')), false,
            'asset-audit 豁免理由已失真: 报告路径落进受保护区');
        },
      },
      'waiver-ledger.cjs': {
        why: '只写 var/cbb/ 与 catalog/ 各一份台账。',
        check() {
          for (const rel of ['var/cbb/waiver-ledger.json', 'catalog/waiver-ledger.json']) {
            assert.equal(isProtected(path.join(EA, rel)), false,
              `waiver-ledger 豁免理由已失真: 台账路径 ${rel} 落进受保护区`);
          }
        },
      },
      // 以下四个是本节首次运行时**测试自己抓出来的** —— 人工调查漏掉了它们。
      // 这就是把覆盖率做成判据而不是做成一次盘点的价值。
      'evidence-snapshot.cjs': {
        why: '只写 evidence/<uid>/<version>/ 下的快照; evidence/ 不在受保护区。',
        check() {
          const scan = catalogGen.scanRepository(EA);
          assert.ok(scan.assets.length > 0, 'evidence-snapshot 豁免理由已失真: 扫不到资产');
          for (const a of scan.assets) {
            const dest = path.join(EA, 'evidence', String(a.asset_uid), String(a.version || '0'), 'SNAPSHOT.json');
            assert.equal(isProtected(dest), false,
              `evidence-snapshot 豁免理由已失真: 快照落点 ${dest} 落进受保护区`);
          }
        },
      },
      'maintenance-check.cjs': {
        why: '只写 var/audit/maintenance-report.json 一个报告。',
        check() {
          assert.equal(isProtected(path.join(EA, 'var/audit/maintenance-report.json')), false,
            'maintenance-check 豁免理由已失真: 报告路径落进受保护区');
        },
      },
      'redline-regression.cjs': {
        why: '只写 var/audit/rlout-v2-regression.json 一个报告。',
        check() {
          assert.equal(isProtected(path.join(EA, 'var/audit/rlout-v2-regression.json')), false,
            'redline-regression 豁免理由已失真: 报告路径落进受保护区');
        },
      },
      'test-catalog-audit.cjs': {
        why: '自测脚本, 全部写入都在 os.tmpdir() 的 mkdtemp 沙箱里, 不碰仓库。',
        check() {
          const src = fs.readFileSync(path.join(toolsDir, 'test-catalog-audit.cjs'), 'utf8');
          assert.ok(/mkdtempSync\(path\.join\(os\.tmpdir\(\)/.test(src),
            'test-catalog-audit 豁免理由已失真: 不再使用 os.tmpdir() 沙箱, 写入可能落到仓库里');
        },
      },
    };

    const risky = fs.readdirSync(toolsDir)
      .filter((f) => f.endsWith('.cjs'))
      .filter((f) => {
        const src = fs.readFileSync(path.join(toolsDir, f), 'utf8');
        return /\b(writeFileSync|renameSync|copyFileSync)\b/.test(src)
          && /\b(discoverManifestPaths|scanRepository)\b/.test(src);
      });
    assert.ok(risky.length >= 6,
      `期望至少 6 个"遍历资产集且写文件"的工具, 实得 ${risky.length} —— 探测规则多半失效了`);

    const unguarded = [];
    for (const f of risky) {
      const src = fs.readFileSync(path.join(toolsDir, f), 'utf8');
      const guarded = /require\(['"]\.\/lib\/protected-write\.cjs['"]\)/.test(src);
      if (guarded) continue;
      if (EXEMPT[f]) { EXEMPT[f].check(); continue; }
      unguarded.push(f);
    }
    assert.deepEqual(unguarded, [],
      `以下工具会遍历资产集并写文件, 却既不调 lib/protected-write.cjs 也没有登记豁免: ${unguarded.join(', ')}。`
      + ' 经 Bash 运行的脚本不过 PreToolUse hook —— 受保护路径的判定必须由写入方自己做。');

    // 已登记的豁免不得凭空长出来: 每条都必须对应一个真实存在且确实"有风险"的工具
    for (const f of Object.keys(EXEMPT)) {
      assert.ok(risky.includes(f),
        `豁免登记了 ${f}, 但它已不在"遍历资产集且写文件"之列 —— 该条豁免应删除, 否则是一条空转的例外`);
    }

    // ── 4b. MATLAB 侧的同一个洞 (棘轮: 锁住现状, 防新增) ──
    // 第 4 节只覆盖 tools/*.cjs。但 golden 侧的 generate_vectors.m 之流是 **MATLAB**,
    // 直接 fopen 写进 models/**/vectors/ —— hook 够不着 (经 Bash 跑), Node 库也够不着。
    // 2026-08-09 实测: 一次 generate_vectors(struct('nsym',32)) 改写了
    // models/comm/channel_est/vectors/ 下三个文件, 无令牌、无审计、无拦截。
    //
    // tools/lib/protected_write_check.m 已补上 MATLAB 侧的判定+消费+留痕 (自测 5/5),
    // 但**接线要改 models/** 里的脚本, 需受保护写入令牌**, 尚未完成。
    // 故此处先做棘轮而不是直接判红: 已知未接线的这批列在 BASELINE 里, 是显式欠账;
    // **新增一个未接线的 MATLAB 写入方即失败**。接线完成后把它从 BASELINE 划掉,
    // BASELINE 清空即表示这个洞补完。
    // 直接判红会让整套 445 条变红而挡住其它工作 —— 那不是判据该干的事; 但沉默同样
    // 不行, 所以取棘轮: 现状被锁死, 债务写在代码里而不是只写在对话里。
    const MATLAB_UNWIRED_BASELINE = [
      'models/comm/channel_est/src/generate_vectors.m',
      'models/comm/ldpc/dump_rtl_trace.m',
      'models/comm/ldpc/gen_encoder_test_vectors.m',
      'models/comm/ldpc/gen_rtl_test_vectors.m',
      'models/comm/ofdm/src/generate_vectors.m',
      'models/comm/rrc/rrc_coeff_gen.m',
      'models/comm/rrc/run_rrc_sim.m',
      'models/comm/rrc/src/generate_vectors.m',
      'models/comm/synch/src/generate_vectors.m',
    ];
    {
      const eaRoot = path.join(ROOT, 'engineering-assets');
      const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, out);
          else if (e.isFile() && e.name.endsWith('.m')) out.push(p);
        }
        return out;
      };
      // 判"是不是写入方"必须认**打开模式**, 不能只认 fopen 三个字母。
      // 2026-08-11 实测反例: models/comm/ldpc/measure_ranges.m 全篇只有 fopen(p,'r'),
      // 读向量统计中间量动态范围, 一个字节都不写, 却被初版判据算成"未接守卫的写入方"。
      // 给只读脚本接写入守卫不是"稳妥", 是错的 —— 它会去消费令牌、去写审计, 把没发生的
      // 写入记成发生了。
      // 认不出来的一律算写入方(模式非字面量、括号配对失败): 判据宁可多管一个, 少管等于漏。
      const fopenArgs = (src) => {
        const clean = src.split(/\r?\n/).filter((l) => !/^\s*%/.test(l)).join('\n');
        const out = [];
        const re = /\bfopen\s*\(/g;
        let m;
        while ((m = re.exec(clean)) !== null) {
          let depth = 1; let quote = null; let i = re.lastIndex;
          for (; i < clean.length && depth > 0; i += 1) {
            const ch = clean[i];
            if (quote) { if (ch === quote) quote = null; continue; }
            if (ch === "'" || ch === '"') { quote = ch; continue; }
            if (ch === '(') depth += 1;
            else if (ch === ')') depth -= 1;
          }
          out.push(depth === 0 ? clean.slice(re.lastIndex, i - 1) : null);
        }
        return out;
      };
      const splitTop = (s) => {
        const parts = []; let depth = 0; let quote = null; let cur = '';
        for (const ch of s) {
          if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
          if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
          if ('([{'.includes(ch)) depth += 1;
          else if (')]}'.includes(ch)) depth -= 1;
          if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
          cur += ch;
        }
        parts.push(cur);
        return parts.map((p) => p.trim());
      };
      const opensForWrite = (src) => fopenArgs(src).some((call) => {
        if (call === null) return true;                       // 括号没配上 -> 按写入方算
        const args = splitTop(call);
        if (args.length < 2) return false;                    // 单参 fopen: MATLAB 默认只读
        const lit = /^(['"])([^'"]*)\1$/.exec(args[1]);
        if (!lit) return true;                                // 模式不是字面量 -> 按写入方算
        return /^[waWA]|\+/.test(lit[2]);                     // w/a/W/A 或任意 '+' (含 r+)
      });

      const writers = walk(path.join(eaRoot, 'models'))
        .filter((f) => opensForWrite(fs.readFileSync(f, 'utf8')))
        .filter((f) => !/protected_write_check/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(eaRoot, f).replace(/[\\]/g, '/'))
        .sort();

      const added = writers.filter((f) => !MATLAB_UNWIRED_BASELINE.includes(f));
      assert.deepEqual(added, [],
        `新增了未接守卫的 MATLAB 写入方: ${added.join(', ')}。`
        + ' models/** 是受保护区, 而 MATLAB 脚本经 Bash 跑, hook 与 Node 库都够不着 ——'
        + ' 请在写入前调 tools/lib/protected_write_check.m。');

      const stale = MATLAB_UNWIRED_BASELINE.filter((f) => !writers.includes(f));
      assert.deepEqual(stale, [],
        `BASELINE 里这几条已不再是未接线的写入方, 应从清单划掉: ${stale.join(', ')}`);
    }

    // ── 5. 库侧放行必须**消费令牌并留痕** (owner 2026-08-09 裁定: 责任在库, 不推给 hook) ──
    // 早先分工是"判定归库、消费归 hook"; 但 hook 在 Bash 路径上根本不运行 —— 那正是
    // 本库存在的理由 —— 于是两边都不消费、都不留痕。2026-08-09 实测: 一次经批准的
    // manifest-hash-refresh --write 写完后 remainingWrites 仍是 1, 审计账本无新条目。
    //
    // 令牌与审计路径由 __dirname 上溯三层解析, 故把库拷进临时树里跑, 免得动真账本
    // (与 golden-protection-contract 的 tokenFixture 同一手法)。
    {
      const libRoot = path.join(tmp, 'lib-fixture');
      const libDir = path.join(libRoot, 'engineering-assets', 'tools', 'lib');
      fs.mkdirSync(libDir, { recursive: true });
      fs.copyFileSync(path.join(toolsDir, 'lib', 'protected-write.cjs'),
        path.join(libDir, 'protected-write.cjs'));
      const auditDir2 = path.join(libRoot, 'var', 'audit');
      fs.mkdirSync(auditDir2, { recursive: true });
      const approvals = path.join(auditDir2, 'protected-write-approvals.json');
      const ledger = path.join(auditDir2, 'protected-writes.jsonl');

      const TOKEN = {
        scope: 'engineering-assets/models/comm/fixture',
        decision: 'FIXTURE-1',
        reason: '契约夹具: 验证库侧放行会消费令牌并留痕',
        basis: { kind: 'maintenance', ref: 'guard-coverage-contract' },
        remainingWrites: 2,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      fs.writeFileSync(approvals, JSON.stringify([TOKEN], null, 1), 'utf8');

      const lib = require(path.join(libDir, 'protected-write.cjs'));
      const target = 'engineering-assets/models/comm/fixture/manifest.json';
      const remaining = () => {
        const list = JSON.parse(fs.readFileSync(approvals, 'utf8'));
        return list.length ? Number(list[0].remainingWrites) : 0;
      };
      const ledgerLines = () => (fs.existsSync(ledger)
        ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []);

      // 未受保护路径: 放行, 但**不得**消费令牌、不得留痕
      assert.equal(lib.blockReason('engineering-assets/cbb/x/rtl/x.sv', { tool: 'fx' }), null);
      assert.equal(remaining(), 2, '未受保护的写入不该消费令牌');
      assert.equal(ledgerLines().length, 0, '未受保护的写入不该进审计账本');

      // 受保护 + 有令牌: 放行, 且扣一次、留一条
      assert.equal(lib.blockReason(target, { tool: 'fx' }), null);
      assert.equal(remaining(), 1, '库侧放行必须消费令牌 —— 不消费等于令牌成了长期开关');
      let lines = ledgerLines();
      assert.equal(lines.length, 1, '库侧放行必须写审计 —— 不留痕等于账本有洞而无人知道');
      assert.equal(lines[0].file, target);
      assert.equal(lines[0].reason, TOKEN.reason);
      assert.equal(lines[0].via, 'tool', '库侧记录要能与 hook 侧区分');
      assert.equal(lines[0].tool, 'fx');
      assert.ok(lines[0].pattern, '要记下命中的是哪一条保护模式');

      // 第二次: 扣光, 令牌移除
      assert.equal(lib.blockReason(target, { tool: 'fx' }), null);
      assert.equal(remaining(), 0, '扣光后令牌应被移除');
      assert.equal(ledgerLines().length, 2);

      // 第三次: 无令牌 -> 拦下, 且不得再多写审计
      const why = lib.blockReason(target, { tool: 'fx' });
      assert.ok(typeof why === 'string' && why.includes('未写入'), '令牌用尽后必须拦下');
      assert.equal(ledgerLines().length, 2, '被拦下的写入不该进审计账本');

      // 缺 reason 的令牌不得放行 —— 无理由的放行不可审计
      fs.writeFileSync(approvals, JSON.stringify([{ ...TOKEN, reason: '   ' }], null, 1), 'utf8');
      const why2 = lib.blockReason(target, { tool: 'fx' });
      assert.ok(typeof why2 === 'string' && why2.includes('reason'), '缺 reason 的令牌必须被拒');
      assert.equal(ledgerLines().length, 2);
    }

    console.log(`guard-coverage-contract: ${report.coveredCategories}/${report.categories} categories covered, `
      + `${report.casesExecuted} cases executed; `
      + `tool-side: ${risky.length} risky tools, ${risky.length - Object.keys(EXEMPT).length} guarded, `
      + `${Object.keys(EXEMPT).length} exempt (reasons re-verified); all assertions passed`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main();
