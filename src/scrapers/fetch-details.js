#!/usr/bin/env node
/**
 * 猎聘详情抓取 - Phase 1 of AI Pipeline
 * 1. 从 jobs 库中找出 job_description IS NULL 且薪资不为空的帖子
 * 2. 用 Puppeteer 逐个打开详情页
 * 3. 提取详细职位说明存回数据库 job_description 字段
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

async function fetchJobDescription(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // --- 进阶反爬机制：仿真人类行为 (随机触发子集) ---

        // 1. 初始视觉停留 (人类刚打开网页时的停顿)
        await sleep(randomRange(2500, 5000));

        try {
            // 随机决定执行哪些动作，避免每次行为完全固定而产生规律
            const availableActions = ['mouse', 'scroll', 'click'];
            // 随机洗牌并取出 1 到 2 个动作执行
            const shuffled = availableActions.sort(() => 0.5 - Math.random());
            const selectedActions = shuffled.slice(0, randomRange(1, 2));

            for (const action of selectedActions) {
                if (action === 'mouse') {
                    // 仿真鼠标随意移动
                    await page.mouse.move(randomRange(100, 800), randomRange(100, 600), { steps: randomRange(5, 15) });
                    await sleep(randomRange(500, 1500));
                } else if (action === 'scroll') {
                    // 仿生平滑滚动
                    await page.evaluate(() => {
                        window.scrollBy({ top: Math.floor(Math.random() * 600) + 300, behavior: 'smooth' });
                    });
                    await sleep(randomRange(1500, 3500)); // 滚动后阅读停顿
                } else if (action === 'click') {
                    // 随机找页面中段安全区点击
                    await page.mouse.move(randomRange(200, 800), randomRange(200, 800), { steps: randomRange(5, 12) });
                    await page.mouse.click(randomRange(200, 800), randomRange(200, 800));
                    await sleep(randomRange(1000, 3000));
                }
            }

        } catch (simErr) {
            console.log("[反爬仿真] 模拟交互执行失败 (非致命):", simErr.message);
        }

        // 岗位详情通常在特定的 content 块里，公司名称也在特定元素
        const data = await page.evaluate(() => {
            let desc = '';
            let offlineMsg = '';

            let blockMsg = '';

            // 先尝试检查是否是停招、下线页面
            const maybeOffline = document.body.innerText || '';
            const pageTitle = document.title || '';
            const currentUrl = window.location.href || '';

            // 1. 明确的拦截/登录验证金刚盾
            if (currentUrl.includes('wow.liepin.com') || currentUrl.includes('passport.liepin.com') || pageTitle.includes('登录') || pageTitle.includes('验证') || maybeOffline.includes('安全中心') || document.querySelector('.login-box, #captcha, .captcha-modal')) {
                blockMsg = 'CAPTCHA';
                desc = '';
            }
            // 2. 明确的下线判断 (页面明确显示停止投递的按钮区域)
            else if (document.querySelector('.apply-stop-title') || document.querySelector('.stop-apply-header') || document.querySelector('.stop-job-apply-operate') || pageTitle.includes('暂停招聘') || pageTitle.includes('下线')) {
                offlineMsg = '[UNAVAILABLE: OFFLINE] 该职位已下线或暂停招聘';
                desc = offlineMsg;
            }
            // 查找主岗位信息容器
            const jobHeader = document.querySelector('.job-apply-container, .job-apply-content');
            const jobIntro = document.querySelector('.job-intro-container');
            const companyAside = document.querySelector('.company-info-container, aside');

            // 1. 解析描述 (Job Description)
            // 优先找标准的 [data-selector="job-intro-content"]
            const descEl = document.querySelector('dd[data-selector="job-intro-content"]');
            if (descEl) {
                desc = descEl.innerText.trim();
            } else if (jobIntro) {
                // 仅在主职位介绍容器内查找，避免误抓侧边栏或底部
                const subDesc = jobIntro.querySelector('dd, .paragraph, .content');
                if (subDesc) desc = subDesc.innerText.trim();
            }

            // 2. 解析公司名 (Company Name)
            let comp = '';
            const compEl = (companyAside ? companyAside.querySelector('.name, .company-name') : null) ||
                document.querySelector('.job-title-info .company-name');
            if (compEl) {
                comp = compEl.innerText.trim();
            }

            // 3. 解析地点 (Location)
            let loc = '';
            const locEl = (jobHeader ? jobHeader.querySelector('.job-properties span:first-child') : null) ||
                document.querySelector('.city-info, .job-title-info .city');
            if (locEl) {
                loc = locEl.innerText.trim();
            }

            // 4. 解析更新时间 (Update Time)
            let updateTime = '';
            const timeEl = (jobHeader ? jobHeader.querySelector('.update-time') : null) ||
                document.querySelector('.time-factor-wrap, time');
            if (timeEl) {
                updateTime = timeEl.innerText.replace('更新时间：', '').replace('更新', '').trim();
            }

            // 5. 解析职位名 (Job Title) - CLI 模式专用覆盖
            let title = '';
            const titleEl = (jobHeader ? jobHeader.querySelector('.name') : null) ||
                document.querySelector('.job-title-info .job-title');
            if (titleEl) {
                title = titleEl.innerText.trim();
            }

            // 6. 解析薪资 (Salary)
            let salary = '';
            const salaryEl = (jobHeader ? jobHeader.querySelector('.salary') : null) ||
                document.querySelector('.job-title-info .salary');
            if (salaryEl) {
                salary = salaryEl.innerText.trim();
            }

            return { desc, title, company: comp, location: loc, salary, updateTime: updateTime, isOffline: !!offlineMsg, isBlock: !!blockMsg };
        });

        // 取消了截图逻辑
        if (data.isOffline) {
            console.log(`[诊断] 页面标题: ${await page.title()}, 当前跳转URL: ${page.url()} -> 页面明确显示已下线/暂停招聘`);
        } else if (data.isBlock) {
            console.log(`[诊断] 页面标题: ${await page.title()}, 当前跳转URL: ${page.url()} -> 遭遇登录/验证墙拦截（请注意处理前端滑块）`);
        } else if (!data.desc || data.desc.length <= 10) {
            console.log(`[诊断] 页面标题: ${await page.title()}, 当前跳转URL: ${page.url()} -> 未提取到内容`);
        }

        return data;
    } catch (err) {
        console.error(`访问页面失败 ${url}:`, err.message);
        return null;
    }
}

// Argument parsing with typo protection
const validArgs = ['--dry-run', '-d'];
const unknownArgs = process.argv.slice(2).filter(arg => arg.startsWith('-') && !validArgs.includes(arg) && isNaN(parseInt(arg)));

if (unknownArgs.length > 0) {
    console.error(`\n[ERROR] Unknown or mistyped arguments: ${unknownArgs.join(', ')}`);
    console.error(`Available flags: --dry-run (or -d) for safe testing.`);
    process.exit(1);
}

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
const minScoreArg = process.argv.find(arg => !arg.startsWith('-') && !isNaN(parseInt(arg)));
const minScore = minScoreArg ? parseInt(minScoreArg, 10) : null;
const cliUrls = process.argv.slice(2).filter(arg => arg.startsWith('http'));
const isCliMode = cliUrls.length > 0;

async function main() {
    console.log(`\n======================================================`);
    console.log(`[配置] 启动定制化捞取模式${dryRun ? ' [DRY RUN]' : ''}`);
    if (minScore !== null) {
        console.log(` => 设置最低分数线: >= ${minScore} (低于此分数的岗位如果缺失 update_time 等将不被获取)`);
    } else {
        console.log(` => 未设置最低分数线，将无差别捞取所有信息缺失的岗位`);
    }
    if (dryRun) {
        console.log(`[DRY RUN MODE] Changes will not be saved to database.`);
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

    try {
        // 首先尝试连接可能由于上一个爬虫开着的浏览器
        let connected = false;
        for (const port of envPorts) {
            try {
                browser = await puppeteer.connect({ browserURL: `http://localhost:${port}`, defaultViewport: null });
                console.log(`[Chrome] 成功复用端口 ${port} 的已有实例。`);
                connected = true;
                break;
            } catch (e) { }
        }
        if (!connected) throw new Error("No existing chrome session found");
    } catch (e) {
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
            ]
        });
    }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    while (true) {
        let jobsToProcess = [];

        if (isCliMode) {
            jobsToProcess = cliUrls.map(url => ({
                id: null,
                title: 'CLI URL',
                company: 'Unknown',
                location: '',
                salary: null,
                link: url,
                job_description: null,
                update_time: null
            }));
        } else {
            // 获取所有存在空缺字段且本轮尚未抓取过的岗位。
            const res = await dbClient.query(`
        SELECT id, title, company, location, salary, link, job_description, 
               match_score, match_score_qwen3_8b, match_score_glm5, update_time
        FROM liepin_jobs 
        WHERE (
                job_description IS NULL
              ) OR (
                job_description NOT LIKE '[UNAVAILABLE%' AND 
                job_description NOT LIKE '[FILTERED%' AND
                (GREATEST(COALESCE(match_score, 0), COALESCE(match_score_qwen3_8b, 0), COALESCE(match_score_glm5, 0)) >= $2 OR $2 IS NULL) AND 
                (
                    update_time IS NULL OR 
                    company IS NULL OR company = '' OR
                    location IS NULL OR location = '' OR location = '不限' OR
                    salary IS NULL OR salary = ''
                )
              )
          AND NOT (id = ANY($3::int[]))
        ORDER BY 
          CASE WHEN job_description IS NULL THEN 0 ELSE 1 END,
          GREATEST(COALESCE(match_score, 0), COALESCE(match_score_qwen3_8b, 0), COALESCE(match_score_glm5, 0)) DESC NULLS LAST, 
          fetched_at DESC 
        LIMIT $1;
      `, [BATCH_SIZE, minScore, Array.from(processedIds)]);

            jobsToProcess = res.rows;
        }

        if (jobsToProcess.length === 0) {
            console.log(`没有找到需要抓取详情的职位 (或者都已抓取完)。`);
            break;
        }

        console.log(`\n================================`);
        console.log(`准备抓取本批次 ${jobsToProcess.length} 个岗位详情...${dryRun ? ' [DRY RUN]' : ''}`);
        console.log(`================================\n`);

        let successCount = 0;

        for (let i = 0; i < jobsToProcess.length; i++) {
            const job = jobsToProcess[i];
            console.log(`[${i + 1}/${jobsToProcess.length}] 正在抓取: ${job.company} - ${job.title}...`);

            // 打开链接抓取文本
            let data = await fetchJobDescription(page, job.link);

            if ((!data || !data.desc || data.desc.length <= 10) && !(data && (data.isOffline || data.isBlock))) {
                console.log(` => 未能在初次提取到有效的职责描述。可能是遇到了结构变更...`);
                data = await fetchJobDescription(page, job.link);
            }

            const updates = [];
            let currentDesc = job.job_description;
            let currentCompany = job.company;
            let currentLocation = job.location;
            let currentSalary = job.salary;
            let currentUpdate = job.update_time;

            if (data && (data.isBlock || data.isOffline || (data.desc && data.desc.length > 10))) {
                if (data.isBlock) {
                    const stopTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                    console.error(`\n[CRITICAL ERROR] [${stopTime}] 🚨 检测到猎聘防爬风控拦截！爬虫立刻安全停机。`);
                    if (dryRun) {
                        console.log(`[DRY RUN] Would wait for 60s and exit.`);
                    } else {
                        console.log(`\n⏳ 为您停留 60 秒... 请在打开的浏览器窗口中手动完成登录或滑块验证。`);
                        await new Promise(resolve => setTimeout(resolve, 60000));
                    }
                    process.exit(1);
                } else if (data.isOffline) {
                    console.log(` => 页面明确提示已下线/已停招。标记状态。`);
                    if (!currentDesc || !currentDesc.includes('OFFLINE')) updates.push('状态变更: 已下线');
                    currentDesc = '[UNAVAILABLE: OFFLINE] 该职位已下线或停止招聘';
                } else {
                    console.log(` => 成功提取 (${data.desc.length} 字符)。正在存入 DB。`);
                    if (!job.job_description) updates.push('补充岗位描述');
                    currentDesc = data.desc;
                }

                if ((!currentCompany || currentCompany.trim() === '' || currentCompany === 'Unknown') && data.company) {
                    currentCompany = data.company;
                    updates.push(`补充公司名`);
                }

                if (isCliMode && job.title === 'CLI URL' && data.title) {
                    job.title = data.title;
                }

                if ((!currentLocation || currentLocation.trim() === '' || currentLocation === '不限') && data.location) {
                    currentLocation = data.location;
                    updates.push(`补充地点`);
                }

                if ((!currentSalary || currentSalary.trim() === '') && data.salary) {
                    currentSalary = data.salary;
                    updates.push(`补充薪资: ${currentSalary}`);
                }

                if (data.updateTime && data.updateTime !== currentUpdate) {
                    currentUpdate = data.updateTime;
                    updates.push(`更新时间: ${currentUpdate}`);
                }

                if (!dryRun && !isCliMode) {
                    await dbClient.query(`
                        UPDATE liepin_jobs 
                        SET job_description = $1, company = $2, location = $3, update_time = $4, salary = $5, fetched_at = NOW()
                        WHERE id = $6;
                    `, [currentDesc, currentCompany, currentLocation, currentUpdate || null, currentSalary, job.id]);
                } else if (!dryRun && isCliMode) {
                    await dbClient.query(`
                        INSERT INTO liepin_jobs (link, job_description, company, location, update_time, title, salary, fetched_at) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                        ON CONFLICT (link) DO UPDATE SET 
                            job_description = EXCLUDED.job_description,
                            company = EXCLUDED.company,
                            location = EXCLUDED.location,
                            update_time = EXCLUDED.update_time,
                            salary = EXCLUDED.salary,
                            fetched_at = EXCLUDED.fetched_at;
                    `, [job.link, currentDesc, currentCompany, currentLocation, currentUpdate || null, job.title, currentSalary]);
                } else {
                    console.log(`[DRY RUN] Updated data: ${currentCompany} | ${currentLocation} | ${currentSalary} | ${currentUpdate}`);
                }
                successCount++;

                if (updates.length > 0) {
                    updateReport.push({
                        id: job.id,
                        'score_gemma': job.match_score,
                        'score_qwen': job.match_score_qwen3_8b,
                        'score_glm5': job.match_score_glm5,
                        company: currentCompany,
                        title: job.title,
                        salary: currentSalary,
                        grab_time: new Date().toLocaleString('zh-CN', { hour12: false }),
                        msg: updates.join(' | ') + (dryRun ? ' (MOCK)' : '')
                    });
                }
            } else {
                console.log(` => 抓取不到详情(非下线，原因未知)。保留原状。`);
            }

            processedIds.add(job.id);

            if (i < jobsToProcess.length - 1) {
                const waitMs = randomRange(8000, 15000);
                await sleep(waitMs);
            }
        }

        if (isCliMode) {
            console.log("CLI模式单次爬取结束。");
            break;
        }

        console.log(`\n本批次处理完毕。休息 10 秒后处理下一批...`);
        await sleep(10000);
        if (dryRun && successCount > 0) break; // Limit dry run to one batch
    }

    console.log(`\n========================================`);
    console.log(`🎊 全部抓取/处理完成！${dryRun ? ' [DRY RUN]' : ''}`);
    console.log(`========================================\n`);

    if (updateReport.length > 0) {
        console.log(`▶ 本次运行综合报告：`);
        console.table(updateReport, ['id', 'score_gemma', 'score_qwen', 'score_glm5', 'company', 'title', 'salary', 'grab_time', 'msg']);
        console.log(`共更新了 ${updateReport.length} 个岗位信息。`);
    } else {
        console.log(`▶ 本次运行综合报告：\n未发现任何信息缺失或状态变更的岗位。`);
    }
    console.log(`\n`);

    await page.close();
    await dbClient.end();
}

main().catch(err => {
    const stopTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.error(`[${stopTime}] 致命脚本错误中止:`, err);
    process.exit(1);
});
