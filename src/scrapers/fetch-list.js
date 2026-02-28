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

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const STATE_FILE = path.join(__dirname, '..', '..', '.jobs_state.json');
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

// Load environment variables if available
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed, using system env
}

// DB Config
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'jobs',
  user: process.env.DB_USER || 'z',
  password: process.env.DB_PASSWORD || ''
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureSessionPage() {
  let browser;
  let reused = false;
  // Default ports if not specified in .env
  const defaultPorts = [18800, 9222, 18792];
  const envPorts = process.env.CHROME_DEBUG_PORTS ?
    process.env.CHROME_DEBUG_PORTS.split(',').map(p => parseInt(p.trim(), 10)) :
    defaultPorts;

  for (const port of envPorts) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${port}`,
        defaultViewport: null
      });
      reused = true;
      console.log(`[Session] 已连接到端口 ${port} 的已有Chrome`);
      break;
    } catch (e) {
    }
  }

  if (!reused) {
    const userDataDir = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '..', '..', 'chrome_profile');
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      defaultViewport: null,
      args: [
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    console.log(`[Session] 无法连接任何已有Chrome，启动新实例 (Headless: false)`);
  }

  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE_LOG:', msg.text()));
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  return { browser, page, reused };
}

async function runOneKeywordAndSaveToDB(page, dbClient, keyword, cityCode = '010') {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://www.liepin.com/zhaopin/?key=${encodedKeyword}&city=${cityCode}&dq=${cityCode}&currentPage=1`;

  try {
    console.log(`\n[${keyword}] 打开第${pageNum}页...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await sleep(8000);
    // 模拟轻微滚动触发加载
    await page.evaluate(() => { window.scrollTo(0, 400); });
    await sleep(1000);
    await page.evaluate(() => { window.scrollTo(0, 800); });
    await sleep(1000);
    await page.evaluate(() => { window.scrollTo(0, 1200); });
    await sleep(1000);

    const result = await page.evaluate(() => {
      // 获取最大页码
      let maxPage = 0;
      const paginationElements = document.querySelectorAll('.ant-pagination-item');
      if (paginationElements && paginationElements.length > 0) {
        // 找到页码数字最大的那个
        const pageNumbers = Array.from(paginationElements).map(el => parseInt(el.textContent, 10)).filter(n => !isNaN(n));
        if (pageNumbers.length > 0) {
          maxPage = Math.max(...pageNumbers) - 1; // Liepin currentPage is 0-indexed
        }
      }

      const items = Array.from(document.querySelectorAll('[class*="job-card-pc-container"]'));
      const rawJobs = items.map(item => {
        const lines = item.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l !== '【' && l !== '】');
        const linkEl = item.querySelector('a[href*="/job/"], a[href*="/a/"]');

        return {
          title: lines[0] || '',
          location: lines[1] || '',
          salary: lines[2] || '',
          company: lines[5] || lines[lines.length - 4] || '未披露',
          link: linkEl ? linkEl.href : ''
        };
      }).filter(j => j.title && j.link);

      return { rawJobs, maxPage };
    });

    console.log(`[${keyword}] 第${pageNum}页抓取到 ${result.rawJobs.length} 个职位元素 (总共可见到页索引: ${result.maxPage})`);
    return result;
  } catch (error) {
    console.error(`[${keyword}] 第${pageNum}页提取失败:`, error.message);
    return { rawJobs: [], maxPage: 0 };
  }
}

async function runOneKeywordAndSaveToDB(page, dbClient, keyword) {
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

    // 清洗和过滤: 仅北京，去参数
    const validJobs = rawJobs
      .filter(j => j.location.includes('北京') || j.location.includes('朝阳') || j.location.includes('海淀')) // 稍微放宽一点兼容简写，但必须是北京的
      .map(j => ({
        ...j,
        link: j.link.split('?')[0]
      }));

    if (validJobs.length === 0) {
      console.log(`[${keyword}] 第${pageNum}页没有符合要求(北京)的职位 (共解析到 ${rawJobs.length} 个职位)。`);
    } else {
      let pageSaved = 0;
      const fetchedAt = new Date();

      for (const job of validJobs) {
        try {
          // ON CONFLICT (link) 会基于唯一链接更新最新抓到的字段(地点、公司)，这恰好弥补以前抓错或者漏掉的值。
          const query = `
            INSERT INTO liepin_jobs (keyword, fetched_at, title, location, salary, company, link)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (link) DO UPDATE SET 
              fetched_at = EXCLUDED.fetched_at,
              keyword = EXCLUDED.keyword,
              title = EXCLUDED.title,
              salary = EXCLUDED.salary,
              company = EXCLUDED.company,
              location = EXCLUDED.location;
          `;
          const values = [keyword, fetchedAt, job.title, job.location, job.salary, job.company, job.link];
          await dbClient.query(query, values);
          pageSaved++;
        } catch (dbErr) {
          console.error(`[DB Error] 插入/更新失败 ${job.title}:`, dbErr.message);
        }
      }
      totalSaved += pageSaved;
      console.log(`[${keyword}] 第${pageNum}页成功入库/更新了 ${pageSaved} 个北京职位 (过滤掉了 ${rawJobs.length - pageSaved} 个非北京)`);
    }

    // 假设一页通常抓到30-40个，如果极少，可能是到底了，但保守起见看是否真的0
    pageNum++;
    await sleep(5000 + Math.random() * 3000); // 翻页休眠 5-8s 防封禁
  }

  return { keyword, totalSaved };
}

async function main() {
  // 1. 尝试初始化数据库连接
  const dbClient = new Client(DB_CONFIG);
  try {
    await dbClient.connect();
    console.log(`[DB] 成功连接到 PostgreSQL (${DB_CONFIG.database})`);
  } catch (err) {
    console.error(`[DB] 数据库连接失败: ${err.message}`);
    process.exit(1);
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
  const cityCode = scraperConfig.city || '010';

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
  console.log(`猎聘检索 Session (直写DB，不写文件，翻页到底)`);
  console.log(`关键词: ${picked.join(' / ')}`);
  console.log(`时间: ${new Date().toLocaleString()}`);
  console.log(`==================================================`);

  // 2. 初始化 Puppeteer
  const { page, reused } = await ensureSessionPage();
  console.log(`[Session] 本轮窗口复用状态: ${reused ? '复用已有Chrome会话' : '新建Chrome会话(可视)'}`);

  // 3. 执行关键词抓取
  const summaries = [];
  for (let i = 0; i < picked.length; i++) {
    const kw = picked[i];
    const result = await runOneKeywordAndSaveToDB(page, dbClient, kw, cityCode);
    summaries.push(result);

    if (i < picked.length - 1) {
      const waitMs = 10000 + Math.floor(Math.random() * 5000);
      console.log(`\n=> [休息] 当前关键词结束，等待 ${Math.round(waitMs / 1000)} 秒后处理下一个...`);
      await sleep(waitMs);
    }
  }

  // 保存最新状态
  state.nextKeywordIndex = (startIdx + batchSize) % keywords.length;
  state.lastRunAt = new Date().toISOString();
  state.lastKeywords = picked;
  state.lastSessionSummary = summaries;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n================ Session汇总 ================`);
  summaries.forEach(s => {
    console.log(`- ${s.keyword}: 成功入库/更新 ${s.totalSaved} 个北京职位`);
  });
  console.log(`下次起始关键词: ${keywords[state.nextKeywordIndex % keywords.length]}`);

  // 清理
  await dbClient.end();
  // 不关闭浏览器，保持复用特性
  console.log(`[完成] 回收 DB 连接，脚本退出。`);
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
