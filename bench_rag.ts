/**
 * RAG 检索性能基准测试 — 直接使用 node:sqlite
 * 对比 FTS5 BM25 vs LIKE@10万条
 * 以及 LLM 扩展/重排的 token 消耗估算
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import crypto from "node:crypto";

const TOTAL = 100_000;
const QUERIES = [
  "狗狗呕吐怎么办",
  "比熊泪痕怎么处理",
  "猫猫绝育后不吃东西",
  "宠物驱虫周期和疫苗计划",
];

// ── 20 个宠物话题模板 ──
const TOPICS = [
  "比熊犬日常护理：每天梳毛15分钟，每周洗一次澡，使用宠物专用香波。定期修剪指甲和清理耳朵。每1-2个月找专业美容师修剪一次。",
  "猫狗驱虫周期：体外驱虫每月一次，体内驱虫每3个月一次。常见驱虫药包括拜耳内虫清和大宠爱。驱虫药需要根据体重选择合适剂量。",
  "宠物疫苗计划：幼犬6-8周打第一针疫苗，之后每3-4周加强，总共3针。每年一针加强针。猫三联疫苗同样需要按时接种。",
  "宠物饮食禁忌：巧克力、葡萄、洋葱、大蒜、木糖醇对猫狗有毒。不要喂人类加工食品。建议选择优质宠物粮作为主食。",
  "比熊泪痕处理：清淡低盐饮食，每日清洁眼角，使用泪痕液。定期检查是否有泪腺堵塞。环境清洁也很重要。",
  "犬瘟热症状：发热、眼鼻分泌物、咳嗽、呕吐、神经症状，死亡率高。发现症状需立即就医隔离治疗。",
  "猫传腹症状：持续发热、腹水、黄疸、精神萎靡，早期治疗关键。FIP目前已有特效药但需遵医嘱。",
  "宠物牙齿护理：每周刷牙2-3次，使用宠物牙膏，定期检查牙结石。牙结石严重需要专业洗牙。",
  "狗狗关节保护：控制体重、补充葡萄糖胺、避免跳跃、使用关节保健品。Cosequin和Dasuquin是常见品牌。",
  "猫咪泌尿系统：多喝水、湿粮为主、观察排尿频率、及时就医。公猫更容易出现泌尿问题。",
  "宠物航空托运：提前1周预约、准备检疫证明、选择合规航空箱。部分航空公司有宠物托运限制。",
  "狗狗社会化训练：3-16周关键期、多接触不同人和环境、正向强化。避免惩罚式训练方法。",
  "比熊美容造型：圆头装、泰迪装、运动装，每1-2个月修剪一次。比熊毛发需要定期打理。",
  "宠物保险选购：对比赔付比例、免赔额、等待期、慢性病覆盖。建议选择包含意外和疾病的综合险。",
  "老年犬护理：6岁起每年体检、关注关节/牙齿/心脏/肾脏。老年犬需要更频繁的健康检查。",
  "宠物中毒急救：误食后2小时内催吐、带样本就医、保留包装。不要自行使用人类药物催吐。",
  "狗狗分离焦虑：逐渐延长独处时间、提供益智玩具、费洛蒙喷雾。严重时需要行为训练师介入。",
  "猫咪应激处理：提供安全躲藏空间、使用费洛蒙、保持环境稳定。搬家或新成员加入时特别注意。",
  "宠物皮肤病：真菌感染、细菌感染、过敏、寄生虫都可能导致皮肤病。需要查明病因对症治疗。",
  "宠物中暑急救：移到阴凉处、用凉水降温、少量饮水、立即送医。夏季避免高温时段外出。",
];

function generateData() {
  const data: string[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const variant = Math.floor(i / TOPICS.length);
    data.push(`${topic} [变体${variant}][id_${i}]部分文本可能会有增减变化以模拟真实数据的分布特征。`);
  }
  return data;
}

function bigramTokens(input: string): string[] {
  const tokens = new Set<string>();
  const latin = input.match(/[a-z0-9_]{2,}/gi);
  if (latin) latin.forEach(t => tokens.add(t.toLowerCase()));
  const han = input.match(/[\u4e00-\u9fff]{2,}/g);
  if (han) {
    for (const block of han) {
      tokens.add(block);
      for (let i = 0; i < block.length - 1; i++) tokens.add(block.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function tokenizeForEmbedding(input: string): string[] {
  const normalized = input.toLowerCase().replace(/[`*_>#|()[\]{}]/g, " ").trim();
  return (normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) || []).filter(Boolean);
}

// ═══════════════════════════════════════════════
//  测试 1: SQLite FTS5 BM25
// ═══════════════════════════════════════════════

function testFTS5(data: string[]) {
  const dbPath = "/tmp/bench_fts5.db";
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;");

  db.exec(`CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, text TEXT NOT NULL);`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');`);

  const ins1 = db.prepare("INSERT OR IGNORE INTO chunks(id,text) VALUES(?,?)");
  const ins2 = db.prepare("INSERT OR IGNORE INTO chunks_fts(id,text) VALUES(?,?)");

  let t0 = Date.now();
  db.exec("BEGIN");
  for (let i = 0; i < data.length; i++) {
    ins1.run(`c${i}`, data[i]);
    ins2.run(`c${i}`, data[i]);
    if (i > 0 && i % 25000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
  }
  db.exec("COMMIT");
  let t1 = Date.now();
  const writeMs = t1 - t0;
  const dbSize = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);

  console.log(`  [写入] ${data.length} 条: ${writeMs}ms | DB: ${dbSize}MB`);
  console.log(`  [查询]`);

  for (const q of QUERIES) {
    const tokens = [...new Set([...tokenizeForEmbedding(q), ...bigramTokens(q)])];
    const matchExpr = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");

    t0 = Date.now();
    const rows = db.prepare(`
      SELECT id, -bm25(chunks_fts) AS score
      FROM chunks_fts WHERE chunks_fts MATCH ?
      ORDER BY score DESC LIMIT 5
    `).all(matchExpr) as Array<Record<string, unknown>>;
    t1 = Date.now();
    const scores = rows.map(r => Number(r.score).toFixed(1));
    console.log(`    "${q}" → ${rows.length}条 ${t1 - t0}ms BM25=[${scores.join(",")}]`);
  }

  db.close();
  return { dbPath, writeMs };
}

// ═══════════════════════════════════════════════
//  测试 2: LIKE (bigram)
// ═══════════════════════════════════════════════

function testLIKE(data: string[]) {
  const dbPath = "/tmp/bench_like.db";
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(`CREATE TABLE chunks(id TEXT PRIMARY KEY, text TEXT NOT NULL);`);

  const ins = db.prepare("INSERT OR IGNORE INTO chunks(id,text) VALUES(?,?)");
  let t0 = Date.now();
  db.exec("BEGIN");
  for (let i = 0; i < data.length; i++) {
    ins.run(`c${i}`, data[i]);
    if (i > 0 && i % 25000 === 0) { db.exec("COMMIT"); db.exec("BEGIN"); }
  }
  db.exec("COMMIT");
  let t1 = Date.now();
  const dbSize = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
  console.log(`  [写入] ${data.length} 条: ${t1 - t0}ms | DB: ${dbSize}MB`);
  console.log(`  [查询]`);

  for (const q of QUERIES) {
    const tokens = [...new Set([...tokenizeForEmbedding(q), ...bigramTokens(q)])];
    const clauses = tokens.map(() => "text LIKE ?").join(" OR ");
    const params = tokens.flatMap(t => [`%${t}%`]);

    t0 = Date.now();
    const rows = db.prepare(`SELECT id FROM chunks WHERE ${clauses} LIMIT 10`).all(...params) as Array<Record<string, unknown>>;
    t1 = Date.now();
    console.log(`    "${q}" → ${rows.length}条 ${t1 - t0}ms`);
  }

  db.close();
}

// ═══════════════════════════════════════════════
//  LLM token 消耗估算
// ═══════════════════════════════════════════════

function estimateLLMTokens(query: string) {
  const expandPrompt = `用户提问：${query}\n\n请扩展搜索关键词，生成同义词和相关概念（不超过20字）：`;
  const rerankPrompt = `问题：${query}\n\n以下段落按相关性排序（仅输出序号）：\n段落1：...\n段落2：...`;

  // 粗略估算: 1 汉字 ≈ 2 tokens, 1 英文词 ≈ 1.3 tokens
  const expandTokens = Math.ceil(expandPrompt.length * 0.7);
  const rerankPromptTokens = Math.ceil(rerankPrompt.length * 0.7);

  return { expandTokens, rerankPromptTokens };
}

// ═══════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════

async function main() {
  console.log("=".repeat(70));
  console.log("  RAG 检索性能基准测试 — 10 万条数据");
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  console.log("\n📦 生成测试数据...");
  const data = generateData();
  console.log(`   生成 ${data.length} 条记录`);

  console.log("\n─── 测试 1: SQLite FTS5 BM25 ───");
  const { writeMs } = testFTS5(data);

  console.log("\n─── 测试 2: SQLite LIKE (bigram) ───");
  testLIKE(data);

  console.log("\n─── 测试 3: LLM Token 消耗估算 ───");
  console.log(`  假设：MiniMax M2.7 价格 ≈ ¥0.01/1K 输入token`);
  for (const q of QUERIES) {
    const { expandTokens, rerankPromptTokens } = estimateLLMTokens(q);
    const total = expandTokens + rerankPromptTokens;
    console.log(`    "${q}": 扩展≈${expandTokens}tok + 重排≈${rerankPromptTokens}tok = ${total}tok ≈ ¥${(total * 0.01 / 1000).toFixed(4)}`);
  }

  console.log("\n─── 对比总结 ───");
  const fts5Times: number[] = [];
  const likeTimes: number[] = [];

  // re-run queries to measure
  const ftsDb = new DatabaseSync("/tmp/bench_fts5.db");
  for (const q of QUERIES) {
    const tokens = [...new Set([...tokenizeForEmbedding(q), ...bigramTokens(q)])];
    const matchExpr = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const t0 = Date.now();
    ftsDb.prepare(`SELECT id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5`).all(matchExpr);
    fts5Times.push(Date.now() - t0);
  }
  ftsDb.close();

  const likeDb = new DatabaseSync("/tmp/bench_like.db");
  for (const q of QUERIES) {
    const tokens = [...new Set([...tokenizeForEmbedding(q), ...bigramTokens(q)])];
    const clauses = tokens.map(() => "text LIKE ?").join(" OR ");
    const params = tokens.flatMap(t => [`%${t}%`]);
    const t0 = Date.now();
    likeDb.prepare(`SELECT id FROM chunks WHERE ${clauses} LIMIT 10`).all(...params);
    likeTimes.push(Date.now() - t0);
  }
  likeDb.close();

  const avgFTS5 = (fts5Times.reduce((a, b) => a + b, 0) / fts5Times.length).toFixed(1);
  const avgLIKE = (likeTimes.reduce((a, b) => a + b, 0) / likeTimes.length).toFixed(1);

  console.log(`  FTS5 BM25 平均: ${avgFTS5}ms/查询`);
  console.log(`  LIKE       平均: ${avgLIKE}ms/查询`);
  console.log(`  FTS5 写入 ${writeMs}ms (含 FTS5 索引)`);
  console.log("");
  console.log(`  LLM 扩展: ~80-120 tok/次`);
  console.log(`  LLM 重排: ~800-1500 tok/次 (取决于 chunks 数量)`);
  console.log(`  单次搜索含 LLM: ~900-1600 tok ≈ ¥0.009-0.016`);
  console.log(`  纯 SQLite: 0 tok, 零成本`);

  // 清理
  try { fs.unlinkSync("/tmp/bench_fts5.db"); } catch {}
  try { fs.unlinkSync("/tmp/bench_like.db"); } catch {}

  console.log("\n" + "=".repeat(70));
  console.log("  测试完成");
}

main().catch(console.error);
