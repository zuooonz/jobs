#!/usr/bin/env node
/**
 * Boss直聘抓取 - 列表提取 (极速版)
 * 特性:
 * 1. 自动翻页到底，直到没有数据
 * 2. 数据库去重 (jobs 库, boss_jobs 表)
 * 3. 注入反反爬防线，跳过 OCR 耗时操作，仅入库基础信息，解码留给详情页
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { injectAntiAntiHook } = require('./utils/boss-stealth');

// Load environment variables (from parent dir)
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const getEnvStrict = (key) => {
    const val = process.env[key];
    if (val === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return val;
};

const CHROME_PATH = getEnvStrict('CHROME_PATH');
const STATE_FILE = path.join(__dirname, '..', '..', '.jobs_state.json');
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

// DB Config
const DB_CONFIG = {
    host: getEnvStrict('DB_HOST'),
    port: parseInt(getEnvStrict('DB_PORT'), 10),
    database: getEnvStrict('DB_NAME'),
    user: getEnvStrict('DB_USER'),
    password: process.env.DB_PASSWORD || ''
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 简单的城市代码映射 (可根据需求扩展)
const CITY_CODE_MAP = {
    '010': '101010100', // 猎聘北京 -> Boss北京
};

async function ensureSessionPage() {
    let browser;
    let reused = false;
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
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });
        console.log(`[Session] 无法连接任何已有Chrome，启动新实例`);
    }

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // 注入反反爬拦截器
    await injectAntiAntiHook(page);

    // 拦截无用请求
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.url().includes('t.zhipin.com')) request.abort();
        else request.continue();
    });

    return { browser, page, reused };
}

async function runOneKeywordAndSaveToDB(page, dbClient, keyword, cityCode, dryRun = false) {
    const encodedKeyword = encodeURIComponent(keyword);
    // Boss 城市码转换，默认 101010100 北京
    const bossCityCode = CITY_CODE_MAP[cityCode] || '101010100';
    const url = `https://www.zhipin.com/web/geek/job?query=${encodedKeyword}&city=${bossCityCode}`;

    let totalSaved = 0;
    console.log(`\n[${keyword}] 打开检索页...`);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
        console.error(`[${keyword}] 打开页面失败: ${e.message}`);
        return { keyword, totalSaved: 0 };
    }

    // 处理风控拦截 (登录重定向) 和安全验证 (滑块/验证码)
    await sleep(2000);
    let currentUrl = page.url();
    if (currentUrl.includes('/web/user/safe/verify') || currentUrl.includes('verify-slider')) {
        console.log("[拦截] 遭遇Boss安全验证机制！页面可能在自动刷新。请立刻在浏览器窗口中【手动点击或拉动滑块通过验证】（等待超时 5 分钟）...");
        try {
            await page.waitForFunction(() => !window.location.href.includes('/safe/verify') && !window.location.href.includes('verify-slider'), { timeout: 300000 });
            console.log("[拦截解除] 验证已通过，刷新目标页...");
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(2000);
        } catch (e) { console.log("[拦截超时] 超过5分钟未完成验证。"); }
    } else if (currentUrl.includes('login.zhipin.com')) {
        console.log("[拦截] 遭遇Boss登录墙风控。等待您手动扫码登录（超时 5 分钟）...");
        try {
            await page.waitForFunction('window.location.hostname !== "login.zhipin.com"', { timeout: 300000 });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(2000);
        } catch (e) { }
    }

    try {
        await page.waitForSelector('.job-card-box', { timeout: 15000 });
    } catch (e) {
        console.log(`[${keyword}] 未找到职位列表，可能此搜索无结果。`);
        return { keyword, totalSaved: 0 };
    }

    let keepGoing = true;
    let scrollCount = 1;
    let seenLinks = new Set();

    while (keepGoing && scrollCount <= 10) {
        // 提取数据
        const result = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.job-card-box'));
            const rawJobs = items.map(item => {
                const titleEl = item.querySelector('.job-name');
                const coEl = item.querySelector('.boss-name') || item.querySelector('.company-name');
                const linkEl = item.querySelector('a.job-name') || item.querySelector('.job-title a');
                const locEl = item.querySelector('.company-location') || item.querySelector('.job-area');
                const salaryEl = item.querySelector('.job-salary') || item.querySelector('.salary');
                return {
                    title: titleEl ? titleEl.innerText.trim() : '',
                    company: coEl ? coEl.innerText.trim() : '',
                    link: linkEl ? linkEl.href : '',
                    location: locEl ? locEl.innerText.trim() : '北京',
                    salary: salaryEl ? salaryEl.innerText.trim() : ''
                };
            }).filter(j => j.title && j.link);

            let hasNextPage = true;
            const noMoreEl = document.querySelector('.page-job-footer.is-last-page') || document.querySelector('.search-no-result');
            if (noMoreEl) hasNextPage = false;

            return { rawJobs, hasNextPage, domCount: items.length };
        });

        const newJobs = result.rawJobs.filter(j => !seenLinks.has(j.link));

        console.log(`[${keyword}] 第 ${scrollCount} 次翻页 (DOM总数: ${result.domCount}), 解析出新职位: ${newJobs.length} 个。`);

        if (newJobs.length === 0 && scrollCount > 1) {
            console.log(`[${keyword}] 本次滚动未发现新数据，提前结束。`);
            break;
        }

        const validJobs = newJobs.map(j => {
            seenLinks.add(j.link);
            let cleanLink = j.link;
            const qIdx = cleanLink.indexOf('?');
            if (qIdx !== -1) cleanLink = cleanLink.substring(0, qIdx);
            return { ...j, link: cleanLink };
        });

        let pageSaved = 0;
        const fetchedAt = new Date();

        for (const job of validJobs) {
            if (!dryRun) {
                try {
                    const query = `
                        INSERT INTO boss_jobs (keyword, fetched_at, title, location, salary, company, link)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (link) DO UPDATE SET 
                            fetched_at = EXCLUDED.fetched_at,
                            keyword = EXCLUDED.keyword,
                            title = EXCLUDED.title,
                            salary = CASE WHEN EXCLUDED.salary != '' THEN EXCLUDED.salary ELSE boss_jobs.salary END,
                            company = EXCLUDED.company,
                            location = EXCLUDED.location;
                    `;
                    const values = [keyword, fetchedAt, job.title, job.location, job.salary, job.company, job.link];
                    await dbClient.query(query, values);
                } catch (dbErr) {
                    console.error(`[DB Error] 插入/更新失败 ${job.title}:`, dbErr.message);
                }
            } else {
                console.log(`[DRY RUN] Detected job: ${job.company} - ${job.title} | Link: ${job.link}`);
            }
            pageSaved++;
        }
        totalSaved += pageSaved;

        keepGoing = result.hasNextPage;
        if (keepGoing && scrollCount < 10) {
            const previousCount = result.domCount;
            // 滚动到底部触发加载
            console.log(`[${keyword}] 向下滚动触发下一页懒加载...`);
            await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
            // 等待 DOM 数量增加
            try {
                await page.waitForFunction(`document.querySelectorAll('.job-card-box').length > ${previousCount}`, { timeout: 8000 });
                await sleep(1000 + Math.random() * 2000);
            } catch (e) {
                const isBottom = await page.evaluate(() => !!document.querySelector('.page-job-footer.is-last-page'));
                if (isBottom) {
                    console.log(`[${keyword}] 已出现“没有更多数据”底栏。`);
                } else {
                    console.log(`[${keyword}] 滚动后无新DOM追加，可能被折叠、拦截或到达上限。`);
                }
                keepGoing = false;
            }
            scrollCount++;
        } else {
            console.log(`[${keyword}] 停止滚动：已到达最后一页或配置的单次抓取最大页数。`);
            break;
        }
    }

    return { keyword, totalSaved };
}

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

async function main() {
    const dbClient = new Client(DB_CONFIG);
    if (dryRun) {
        console.log(`[DRY RUN MODE] Changes will not be saved to database.`);
    } else {
        try {
            await dbClient.connect();
            console.log(`[DB] 成功连接到 PostgreSQL (${DB_CONFIG.database}) - 目标表: boss_jobs`);
        } catch (err) {
            console.error(`[DB] 数据库连接失败: ${err.message}`);
            process.exit(1);
        }
    }

    const cliKeywords = process.argv.slice(2).filter(arg => !arg.startsWith('-'));

    let picked = [];
    let state = { nextBossKeywordIndex: 0 };
    let startIdx = 0;
    let batchSize = 3;
    let keywords = [];

    if (cliKeywords.length > 0) {
        picked = cliKeywords;
        console.log(`[配置] 检测到命令行参数，将不使用默认进度规划。直接抓取。`);
    } else {
        // 读取配置
        let fullConfig = {};
        try {
            if (fs.existsSync(CONFIG_FILE)) fullConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            else throw new Error(`找不到 ${CONFIG_FILE}`);
        } catch (e) {
            console.error(`[ERR] 解析配置失败:`, e.message);
            process.exit(1);
        }

        const scraperConfig = fullConfig.scraper || {};
        keywords = scraperConfig.keywords || [];
        batchSize = scraperConfig.batch_size || 3;

        if (keywords.length === 0) {
            console.error(`[ERR] 配置中没有关键词。`);
            process.exit(1);
        }

        // 独立维护 boss 的检索进度
        try {
            if (fs.existsSync(STATE_FILE)) {
                const rawDb = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                state = { ...rawDb, ...state }; // 保留猎聘的 state
            }
        } catch (e) { }

        startIdx = state.nextBossKeywordIndex || 0;
        startIdx = startIdx % keywords.length;

        for (let i = 0; i < batchSize; i++) {
            picked.push(keywords[(startIdx + i) % keywords.length]);
        }
    }

    const cityCode = '010'; // 默认北京

    console.log(`\n==================================================`);
    console.log(`Boss直聘 极速检索 Session (直写DB，规避OCR防封禁)${dryRun ? ' [DRY RUN]' : ''}`);
    console.log(`关键词: ${picked.join(' / ')}`);
    console.log(`==================================================`);

    const { page, reused, browser } = await ensureSessionPage();

    const summaries = [];
    for (let i = 0; i < picked.length; i++) {
        const kw = picked[i];
        const result = await runOneKeywordAndSaveToDB(page, dbClient, kw, cityCode, dryRun);
        summaries.push(result);

        if (i < picked.length - 1) {
            const waitMs = 15000 + Math.floor(Math.random() * 5000);
            console.log(`\n=> [休息] 当前关键词结束，等待 ${Math.round(waitMs / 1000)} 秒防封后处理下一个...`);
            await sleep(waitMs);
        }
    }

    if (!dryRun) {
        if (cliKeywords.length === 0) {
            state.nextBossKeywordIndex = (startIdx + batchSize) % keywords.length;
            state.lastBossRunAt = new Date().toISOString();
            state.lastBossKeywords = picked;
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }

        console.log(`\n================ Session汇总 ================`);
        summaries.forEach(s => {
            console.log(`- ${s.keyword}: 成功极速入库/更新 ${s.totalSaved} 个Boss职位 (待解码)`);
        });
        await dbClient.end();
    } else {
        console.log(`\n================ [DRY RUN] Session汇总 ================`);
        summaries.forEach(s => {
            console.log(`- ${s.keyword}: 模拟处理了 ${s.totalSaved} 个Boss职位`);
        });
    }

    if (!reused) {
        // 如果我们开启了新浏览器，完成工作后将其关闭
        await browser.close();
    }

    console.log(`[完成] 脚本退出。`);
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
