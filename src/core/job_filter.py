#!/usr/bin/env python3
import psycopg2
import json
import os

# Load environment variables if available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

def get_env_strict(key):
    val = os.getenv(key)
    if val is None:
        raise EnvironmentError(f"Missing required environment variable: {key}")
    return val

# Load user config
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    USER_CONFIG = json.load(f)

BLACK_KEYWORDS = USER_CONFIG.get("strategy", {}).get("filtration", {}).get("black_keywords", [])
MIN_SALARY = USER_CONFIG.get("strategy", {}).get("filtration", {}).get("min_salary", 0)
TARGET_CITIES = USER_CONFIG.get("strategy", {}).get("filtration", {}).get("target_cities", [])

def is_low_salary(salary_str):
    """
    判断薪资是否极低。 
    """
    if not salary_str or salary_str == '面议':
        return False
    
    import re
    # 例如： "5-8k" -> matches "5", "8"
    match = re.search(r'(\d+)-(\d+)k', salary_str.lower())
    if match:
        high_end = int(match.group(2))
        return high_end < MIN_SALARY
    
    match_2 = re.search(r'(\d+)-(\d+)千', salary_str)
    if match_2:
        high_end = int(match_2.group(2))
        return high_end < MIN_SALARY

    return False

# Database configuration
DB_CONFIG = {
    "dbname": get_env_strict("DB_NAME"),
    "user": get_env_strict("DB_USER"),
    "password": os.getenv("DB_PASSWORD", ""), # Password remains optional
    "host": get_env_strict("DB_HOST"),
    "port": get_env_strict("DB_PORT")
}

def contains_black_keyword(title, salary_str=""):
    combined_text = (title + " " + (salary_str or "")).lower()
    for w in BLACK_KEYWORDS:
        if w.lower() in combined_text:
            return True, w
    return False, None

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Filter jobs based on blocklist and target cities")
    parser.add_argument("--dry-run", action="store_true", help="Run without writing to database")
    args = parser.parse_args()

    dry_run = args.dry_run

    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    cur = conn.cursor()
    
    # 捞出全库所有岗位进行统一回溯过滤
    cur.execute("""
        SELECT id, title, company, salary, job_description, location 
        FROM liepin_jobs 
    """)
    jobs = cur.fetchall()
    print(f"找到 {len(jobs)} 个岗位，开始全局极速前置过滤(包含已抓取记录)..." + (" [DRY RUN]" if dry_run else ""))
    
    filtered_count = 0
    salary_filtered = 0
    keyword_filtered = 0
    location_filtered = 0
    restored_count = 0
    
    for j_id, title, company, salary, job_desc, location in jobs:
        reject_reason = None
        
        # 1. 查名字和薪资标签黑名单
        has_black_kw, kw = contains_black_keyword(title, salary)
        if has_black_kw:
            reject_reason = f"[FILTERED: KEYWORD] Rule Pre-filtered: Trivial keyword ({kw})"
            keyword_filtered += 1
            
        # 2. 查薪资是否极其离谱
        elif is_low_salary(salary):
            reject_reason = f"[FILTERED: LOW_SALARY] Rule Pre-filtered: Salary too low ({salary})"
            salary_filtered += 1
            
        # 3. 查工作地点是否明确不在目标城市列表
        elif location and not any(k in location for k in TARGET_CITIES):
            reject_reason = f"[FILTERED: LOCATION] Rule Pre-filtered: Excluded Location ({location})"
            location_filtered += 1
            
        # 执行拦截
        if reject_reason:
            if not dry_run:
                cur.execute("""
                    UPDATE liepin_jobs
                    SET job_description = %s, 
                        match_score = 0, rationale = '前置规则过滤',
                        match_score_qwen3_8b = 0, rationale_qwen3_8b = '前置规则过滤',
                        match_score_glm5 = 0, rationale_glm5 = '前置规则过滤'
                    WHERE id = %s
                """, (reject_reason, j_id))
            print(f"[-] 过滤: [{j_id}] {title} | {salary} -> {reject_reason}")
            filtered_count += 1
        else:
            # 放行：但如果之前被标记为 [FILTERED:]，则需要洗白重置为 NULL，以便后续正常爬取或打分
            if job_desc and str(job_desc).startswith("[FILTERED:"):
                if not dry_run:
                    cur.execute("""
                        UPDATE liepin_jobs
                        SET job_description = NULL, 
                            match_score = NULL, rationale = NULL,
                            match_score_qwen3_8b = NULL, rationale_qwen3_8b = NULL,
                            match_score_glm5 = NULL, rationale_glm5 = NULL
                        WHERE id = %s
                    """, (j_id,))
                restored_count += 1
                print(f"[+] 豁免洗白: [{j_id}] {title} 脱离黑名单，已重置为空白状态。")
            
    print("=" * 40)
    print(f"过滤完成！{' (模拟)' if dry_run else ''}共判定 {filtered_count} 个无效岗位。清洗恢复了 {restored_count} 个脱离黑名单的岗位。")
    print(f" -> 因薪资过低命中: {salary_filtered}")
    print(f" -> 因违禁词命中: {keyword_filtered}")
    print(f" -> 因非北京地区命中: {location_filtered}")
    
    cur.execute("SELECT COUNT(*) FROM liepin_jobs WHERE job_description IS NULL")
    remaining_count = cur.fetchone()[0]
    
    cur.execute("SELECT COUNT(*) FROM liepin_jobs WHERE job_description IS NOT NULL AND job_description NOT LIKE '[FILTERED:%%'")
    fetched_count = cur.fetchone()[0]
    
    print(f"\n✅ 进度报告: 当前数据库中还有 {remaining_count} 个优质岗位等待爬取正文。")
    print(f"✅ 进度报告: 当前数据库中已有 {fetched_count} 个优质岗位成功获取正文。")
    
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()
