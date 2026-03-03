#!/usr/bin/env node
/**
 * 猎聘抓取 - 方式 B (直接写入 PostgreSQL)
 * 特性:
 * 1. 自动翻页到底，直到没有数据
 * 2. 数据库去重 (jobs 库, liepin_jobs 表)
 * 3. Headless: false (显示浏览器界面)
 * 4. 仅保留北京岗位
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Load environment variables (from parent dir)
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const getEnvStrict = (key) => {
  const val = process.env[key];
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
};

// DB Config (Strict)
const DB_CONFIG = {
  host: getEnvStrict('DB_HOST'),
  port: parseInt(getEnvStrict('DB_PORT'), 10),
  database: getEnvStrict('DB_NAME'),
  user: getEnvStrict('DB_USER'),
  password: process.env.DB_PASSWORD || ''
};

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

async function main() {
  // 1. 尝试初始化数据库连接
  const dbClient = new Client(DB_CONFIG);
  if (dryRun) {
    console.log(`[DRY RUN MODE] Changes will not be saved to database.`);
  } else {
    try {
      await dbClient.connect();
      console.log(`[DB] 成功连接到 PostgreSQL (${DB_CONFIG.database})`);
    } catch (err) {
      console.error(`[DB] 数据库连接失败: ${err.message}`);
      process.exit(1);
    }
  }

  // 读取配置
  let fullConfig = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fullConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } else {
      console.warn(`[WARN] 找不到 ${CONFIG_FILE}，将退出。`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[ERR] 解析 ${CONFIG_FILE} 失败:`, e.message);
    process.exit(1);
  }

  const scraperConfig = fullConfig.scraper || {};
  const keywords = scraperConfig.keywords || [];
  const batchSize = scraperConfig.batch_size || 3;

  if (keywords.length === 0) {
    console.error(`[ERR] 配置中没有关键词。`);
    process.exit(1);
  }

  // 读取状态
  let state = { nextKeywordIndex: 0 };
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { }

  let startIdx = state.nextKeywordIndex || 0;
  // 安全越界保护: 如果你删了词库导致变短
  startIdx = startIdx % keywords.length;

  const picked = [];
  for (let i = 0; i < batchSize; i++) {
    picked.push(keywords[(startIdx + i) % keywords.length]);
  }

  console.log(`\n==================================================`);
  console.log(`猎聘检索 Session - 补全模式 (直刷DB)${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`关键词: ${picked.join(' / ')}`);
  console.log(`时间: ${new Date().toLocaleString()}`);
  console.log(`==================================================`);

  // 2. 初始化 Puppeteer
  const { page, reused } = await ensureSessionPage();
  console.log(`[Session] 本轮窗口复用状态: ${reused ? '复用已有Chrome会话' : '新建Chrome会话'}`);

  // 3. 执行关键词抓取
  const summaries = [];
  for (let i = 0; i < picked.length; i++) {
    const kw = picked[i];
    const result = await runOneKeywordAndSaveToDB(page, dbClient, kw, dryRun);
    summaries.push(result);

    if (i < picked.length - 1) {
      const waitMs = 10000 + Math.floor(Math.random() * 5000);
      console.log(`\n=> [休息] 当前关键词结束，等待 ${Math.round(waitMs / 1000)} 秒后处理下一个...`);
      await sleep(waitMs);
    }
  }

  if (!dryRun) {
    // 保存最新状态
    state.nextKeywordIndex = (startIdx + batchSize) % keywords.length;
    state.lastRunAt = new Date().toISOString();
    state.lastKeywords = picked;
    state.lastSessionSummary = summaries;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    console.log(`\n================ Session汇总 ================`);
    summaries.forEach(s => {
      console.log(`- ${s.keyword}: 成功补全了库里 ${s.totalSaved} 个职位信息`);
    });
    console.log(`下次起始关键词: ${keywords[state.nextKeywordIndex % keywords.length]}`);

    // 清理
    await dbClient.end();
  } else {
    console.log(`\n================ [DRY RUN] Session汇总 ================`);
    summaries.forEach(s => {
      console.log(`- ${s.keyword}: 模拟补全了 ${s.totalSaved} 个职位信息`);
    });
  }

  // 不关闭浏览器，保持复用特性
  console.log(`[完成] 脚本退出。`);
  process.exit(0);
}

// Update runOneKeywordAndSaveToDB to handle dryRun
async function runOneKeywordAndSaveToDB(page, dbClient, keyword, dryRun = false) {
  let pageNum = 0;
  let totalSaved = 0;
  let maxPageFound = 999;

  while (pageNum <= maxPageFound) {
    const { rawJobs, maxPage } = await fetchJobsOnePage(page, keyword, pageNum);

    if (pageNum === 0 && maxPage !== undefined) {
      maxPageFound = maxPage;
    }

    if (rawJobs.length === 0) {
      console.log(`[${keyword}] 第${pageNum}页无数据，提前结束。`);
      break;
    }

    // 清洗和过滤: 去参数
    const validJobs = rawJobs
      .map(j => ({
        ...j,
        link: j.link.split('?')[0]
      }));

    if (validJobs.length === 0) {
      console.log(`[${keyword}] 第${pageNum}页没有解析到有效的职位链接。`);
    } else {
      let pageSaved = 0;
      const fetchedAt = new Date();

      for (const job of validJobs) {
        if (!dryRun) {
          try {
            const query = `
              UPDATE liepin_jobs SET 
                fetched_at = $2,
                keyword = COALESCE(NULLIF($1, ''), keyword),
                title = COALESCE(NULLIF($3, ''), title),
                salary = COALESCE(NULLIF($5, ''), salary),
                company = COALESCE(NULLIF($6, ''), company),
                location = COALESCE(NULLIF($4, ''), location)
              WHERE link = $7
              RETURNING id;
            `;
            const values = [keyword, fetchedAt, job.title, job.location, job.salary, job.company, job.link];
            const updateRes = await dbClient.query(query, values);
            if (updateRes.rowCount > 0) {
              pageSaved++;
            }
          } catch (dbErr) {
            console.error(`[DB Error] 更新失败 ${job.title}:`, dbErr.message);
          }
        } else {
          // Check if link exists in some simulated way if needed, or just log
          console.log(`[DRY RUN] Would update/patch job: ${job.company} - ${job.title} | ${job.link}`);
          pageSaved++;
        }
      }
      totalSaved += pageSaved;
      console.log(`[${keyword}] 第${pageNum}页${dryRun ? '模拟' : '成功'}基于URL补全了库里 ${pageSaved} 个已知职位信息`);
    }

    pageNum++;
    await sleep(5000 + Math.random() * 3000); // 翻页休眠 5-8s 防封禁
  }

  return { keyword, totalSaved };
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
