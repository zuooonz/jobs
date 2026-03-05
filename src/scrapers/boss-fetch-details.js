#!/usr/bin/env node
/**
 * Boss直聘详情抓取 - Phase 1 of AI Pipeline
 * 特性:
 * 1. 从 boss_jobs 库中捞取 job_description IS NULL 的岗位
 * 2. 注入反反爬防线，打开详情页获取真实 JD
 * 3. 运行本地 Tesseract OCR 破解乱码薪水，一并写回数据库
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const Tesseract = require('tesseract.js');
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
const USER_DATA_DIR = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '..', '..', 'chrome_profile');

// DB Config
const DB_CONFIG = {
    host: getEnvStrict('DB_HOST'),
    port: parseInt(getEnvStrict('DB_PORT'), 10),
    database: getEnvStrict('DB_NAME'),
    user: getEnvStrict('DB_USER'),
    password: process.env.DB_PASSWORD || ''
};

const BATCH_SIZE = 10; // 每次跑只抓 10 个，防止反爬

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 核心机制 2：字体反爬破解 (OCR 识别)
 */
async function ocrElement(page, elementHandle) {
    if (!elementHandle) return '';
    try {
        const clip = await elementHandle.boundingBox();
        if (!clip) return await page.evaluate(el => el.innerText, elementHandle);
        const screenshotPath = path.join(__dirname, 'temp_ocr.png');
        await page.screenshot({ path: screenshotPath, clip: clip });

        // 使用隐藏文件夹缓存 OCR 识别模型，保持项目根目录整洁
        const cacheDir = path.join(__dirname, '..', '..', '.tesseract');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const worker = await Tesseract.createWorker('eng', 1, {
            langPath: cacheDir,
            cachePath: cacheDir,
            dataPath: cacheDir,
            cacheMethod: 'write'
        });
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789-Kk·薪元天个月以上下'
        });
        const { data: { text } } = await worker.recognize(screenshotPath);
        await worker.terminate();

        let res = text.trim();
        res = res.replace(/[%5S]$/g, '薪')
            .replace(/(\d+)[%5S]/g, '$1薪')
            .replace(/-/g, '-')
            .replace(/(\d+)-(\d+)薪/g, '$1·$2薪')
            .replace(/-(\d+)薪/g, '·$1薪');
        return res;
    } catch (e) {
        return await page.evaluate(el => el.innerText, elementHandle);
    }
}

async function fetchJobDescription(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 风控探测
        await sleep(3000);
        if (page.url().includes('login.zhipin.com')) {
            console.log("[拦截] 遭遇Boss登录墙风控。等待扫码...");
            await page.waitForFunction('window.location.hostname !== "login.zhipin.com"', { timeout: 300000 });
        }

        // 仿真人类行为
        await sleep(randomRange(1500, 3000));
        await page.mouse.move(randomRange(100, 800), randomRange(100, 600), { steps: randomRange(5, 15) });
        await page.evaluate(() => { window.scrollBy({ top: Math.floor(Math.random() * 600) + 300, behavior: 'smooth' }); });
        await sleep(randomRange(1000, 2000));

        try {
            await page.waitForSelector('.job-detail-box, .info-primary, .error-page', { timeout: 15000 });
        } catch (e) {
            console.log("页面加载核心元素超时");
            return null;
        }

        const data = await page.evaluate(() => {
            let desc = '';
            let offlineMsg = '';

            const pageTitle = document.title || '';
            const maybeOffline = document.body.innerText || '';

            if (pageTitle.includes('出错啦') || document.querySelector('.error-page') || maybeOffline.includes('该职位已下线') || maybeOffline.includes('已被BOSS删除')) {
                offlineMsg = '[UNAVAILABLE: OFFLINE] 职位已下线或删除';
                desc = offlineMsg;
            } else {
                const descEl = document.querySelector('.job-sec-text');
                if (descEl) desc = descEl.innerText.trim();
            }

            const compLinks = Array.from(document.querySelectorAll('.sider-company .company-info a') || []);
            const compEl = compLinks.find(el => el.innerText.trim().length > 0) || document.querySelector('.company-info a[target="_blank"]');
            const comp = compEl ? compEl.innerText.trim() : '';

            const titleEl = document.querySelector('.info-primary .name h1') || document.querySelector('.name h1');
            const title = titleEl ? titleEl.innerText.trim() : '';

            const locEl = document.querySelector('.info-primary .text-city') || document.querySelector('.location-address');
            const location = locEl ? locEl.innerText.trim() : '';

            // Boss 没明显提取更新时间的元素，留白
            return { desc, company: comp, title, location, isOffline: !!offlineMsg };
        });

        // OCR 获取薪水明文
        let salary = '';
        if (!data.isOffline) {
            const salaryEl = await page.$('.name .salary');
            const rawSalaryText = await page.evaluate(el => el ? el.innerText : '', salaryEl);

            if (!/[\uE000-\uF8FF]/.test(rawSalaryText) && rawSalaryText.trim().length > 0) {
                // 不包含 Boss 的自定义加密字体区域
                salary = rawSalaryText.trim();
            } else {
                salary = await ocrElement(page, salaryEl);
            }
        }

        data.salary = salary;

        if (data.isOffline) {
            console.log(`[诊断] 页面标题: ${await page.title()} -> 明确显示已下线`);
        } else if (!data.desc || data.desc.length <= 10) {
            console.log(`[诊断] 当前跳转URL: ${page.url()} -> 未提取到内容`);
        }

        return data;
    } catch (err) {
        console.error(`访问页面失败 ${url}:`, err.message);
        return null;
    }
}

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
const minScoreArg = process.argv.find(arg => !arg.startsWith('-') && !isNaN(parseInt(arg)));
const minScore = minScoreArg ? parseInt(minScoreArg, 10) : null;
const cliUrls = process.argv.slice(2).filter(arg => arg.startsWith('http'));
const isCliMode = cliUrls.length > 0;

async function main() {
    console.log(`\n======================================================`);
    console.log(`[配置] 启动 Boss直聘 详情提取 & OCR 解码模式${dryRun ? ' [DRY RUN]' : ''}`);
    if (minScore !== null) {
        console.log(` => 设置最低线: >= ${minScore} (低于此分的将不被拉取补全)`);
    } else {
        console.log(` => 无分数线拦截，捞取所有空缺`);
    }
    console.log(`======================================================\n`);

    const dbClient = new Client(DB_CONFIG);
    try {
        await dbClient.connect();
        console.log(`[DB] 连接成功`);
    } catch (e) {
        console.error(`[DB] 连接失败:`, e.message);
        process.exit(1);
    }

    const processedIds = new Set();
    const updateReport = [];

    // 连接/启动 Chrome
    let browser;
    const defaultPorts = [18800, 9222, 18792];
    const envPorts = process.env.CHROME_DEBUG_PORTS ?
        process.env.CHROME_DEBUG_PORTS.split(',').map(p => parseInt(p.trim(), 10)) :
        defaultPorts;

    let connected = false;
    for (const port of envPorts) {
        try {
            browser = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
            console.log(`[Chrome] 成功复用端口 ${port} 的已有实例。`);
            connected = true;
            break;
        } catch (e) { }
    }
    if (!connected) {
        console.log(`[Chrome] 启动新实例...`);
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false,
            defaultViewport: null,
            args: [
                `--user-data-dir=${USER_DATA_DIR}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });
    }

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    await injectAntiAntiHook(page);

    while (true) {
        let jobsToProcess = [];

        if (isCliMode) {
            if (cliUrls.length === 0) {
                console.log("CLI 指定链接处理完毕。");
                break;
            }
            // 如果提供了命令行 URL，则忽略数据库，直接爬取这些指定链接
            const currentUrl = cliUrls.shift();
            if (currentUrl) {
                // 生成一个伪造的 job 对象，用于满足后面的通用处理逻辑
                // 因是指定链接，没有预先的 id 和匹配分，这里塞一些默认值
                jobsToProcess.push({
                    id: -1, // 标识这是一个临时插入的任务
                    title: '获取中...',
                    company: '',
                    location: '',
                    salary: '',
                    link: currentUrl,
                    job_description: null
                });
            }
        } else {
            const res = await dbClient.query(`
        SELECT id, title, company, salary, link, job_description, 
               match_score, match_score_qwen3_8b, match_score_glm5
        FROM boss_jobs 
        WHERE (
                job_description IS NULL
              ) OR (
                job_description NOT LIKE '[UNAVAILABLE%' AND 
                job_description NOT LIKE '[FILTERED%' AND
                (GREATEST(COALESCE(match_score, 0), COALESCE(match_score_qwen3_8b, 0), COALESCE(match_score_glm5, 0)) >= $2 OR $2 IS NULL) AND 
                (
                    company IS NULL OR company = ''
                )
              )
          AND NOT (id = ANY($3::int[]))
        ORDER BY 
          CASE WHEN job_description IS NULL THEN 0 ELSE 1 END,
          fetched_at DESC 
        LIMIT $1;
      `, [BATCH_SIZE, minScore, Array.from(processedIds)]);
            jobsToProcess = res.rows;
        }

        if (jobsToProcess.length === 0) {
            console.log(`没有找(剩)到需要抓取详情的职位。`);
            break;
        }

        console.log(`\n================================`);
        console.log(`准备抓取本批次 ${jobsToProcess.length} 个岗位详情与薪水 OCR 解码...${dryRun ? ' [DRY RUN]' : ''}`);
        console.log(`================================\n`);

        let successCount = 0;

        for (let i = 0; i < jobsToProcess.length; i++) {
            const job = jobsToProcess[i];
            console.log(`[${i + 1}/${jobsToProcess.length}] 正在抓取: ${job.company} - ${job.title}...`);

            let data = await fetchJobDescription(page, job.link);

            if ((!data || !data.desc || data.desc.length <= 10) && !(data && (data.isOffline || data.isBlock))) {
                console.log(` => 未能在初次提取到有效的职责描述。尝试复刷...`);
                await sleep(2000);
                data = await fetchJobDescription(page, job.link);
            }

            const updates = [];
            let currentDesc = job.job_description;
            let currentCompany = job.company;
            let currentSalary = job.salary;

            if (data && (data.isOffline || (data.desc && data.desc.length > 10))) {
                if (data.isOffline) {
                    currentDesc = '[UNAVAILABLE: OFFLINE] 职位已下线或删除';
                    updates.push('状态变更: 已下线');
                } else {
                    currentDesc = data.desc;
                    updates.push('补充岗位描述');
                }

                if (data.salary && data.salary.length > 0 && data.salary !== currentSalary) {
                    currentSalary = data.salary;
                    updates.push(`OCR薪水解码: ${currentSalary}`);
                }

                if (data.title && data.title.length > 0) job.title = data.title;
                if (data.location && data.location.length > 0) job.location = data.location;

                if (!dryRun) {
                    if (job.id === -1) {
                        // 如果是手动传入的链接，可能库里没有，执行 UPSERT
                        await dbClient.query(`
                            INSERT INTO boss_jobs (keyword, title, company, location, salary, link, job_description, fetched_at)
                            VALUES ('CLI指定链接', $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                            ON CONFLICT (link) DO UPDATE SET 
                                job_description = EXCLUDED.job_description,
                                title = CASE WHEN EXCLUDED.title != '' THEN EXCLUDED.title ELSE boss_jobs.title END,
                                company = CASE WHEN EXCLUDED.company != '' THEN EXCLUDED.company ELSE boss_jobs.company END,
                                location = CASE WHEN EXCLUDED.location != '' THEN EXCLUDED.location ELSE boss_jobs.location END,
                                salary = CASE WHEN EXCLUDED.salary != '' THEN EXCLUDED.salary ELSE boss_jobs.salary END;
                        `, [job.title, data.company || '', job.location || '', currentSalary, job.link, currentDesc]);
                    } else {
                        // 常规遍历空缺记录的 UPDATE
                        await dbClient.query(`
                            UPDATE boss_jobs 
                            SET job_description = $1, company = CASE WHEN $2 != '' THEN $2 ELSE company END, salary = $3
                            WHERE id = $4;
                        `, [currentDesc, data.company || '', currentSalary, job.id]);
                    }
                } else {
                    console.log(`[DRY RUN] Updated data: ${data.company} | ${currentSalary}`);
                }
                successCount++;

                if (updates.length > 0) {
                    updateReport.push({
                        id: job.id,
                        company: job.company || currentCompany,
                        title: job.title,
                        msg: updates.join(' | ') + (dryRun ? ' (MOCK)' : '')
                    });
                }
            } else {
                console.log(` => 抓取不到详情保留原状。`);
            }

            processedIds.add(job.id);

            if (i < jobsToProcess.length - 1) {
                const waitMs = randomRange(10000, 20000); // 间隔加大，Boss 很严加 OCR 双重消耗
                console.log(`   (等待 ${Math.round(waitMs / 1000)} 秒后继续...)`);
                await sleep(waitMs);
            }
        }

        console.log(`\n本批次处理完毕。休息 10 秒后处理下一批...`);
        await sleep(10000);
        if (dryRun && successCount > 0) break;
    }

    console.log(`\n========================================`);
    console.log(`🎊 全部抓取/处理完成！${dryRun ? ' [DRY RUN]' : ''}`);
    console.log(`========================================\n`);

    if (updateReport.length > 0) {
        console.log(`▶ 本次运行综合报告：`);
        console.table(updateReport, ['id', 'company', 'title', 'msg']);
        console.log(`共更新了 ${updateReport.length} 个岗位信息。`);
    }

    if (!connected) {
        await browser.close();
    }

    try {
        if (fs.existsSync(path.join(__dirname, 'temp_ocr.png'))) {
            fs.unlinkSync(path.join(__dirname, 'temp_ocr.png'));
        }
    } catch (e) { }

    await dbClient.end();
}

main().catch(err => {
    const stopTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.error(`[${stopTime}] 致命脚本错误中止:`, err);
    process.exit(1);
});
