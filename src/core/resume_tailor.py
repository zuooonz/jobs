#!/usr/bin/env python3
import os
import psycopg2
import re
import json
from openai import OpenAI
from collections import defaultdict
from datetime import datetime

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

# DB CONFIG
DB_CONFIG = {
    'dbname': get_env_strict('DB_NAME'),
    'user': get_env_strict('DB_USER'),
    'password': os.getenv('DB_PASSWORD', ''),
    'host': get_env_strict('DB_HOST'),
    'port': get_env_strict('DB_PORT')
}

# Connection Config from .env (Higher priority for infrastructure)
API_BASE = get_env_strict("GEMMA_API_BASE")
API_KEY = get_env_strict("GEMMA_API_KEY")
MODEL_NAME = get_env_strict("GEMMA_MODEL_NAME")

# Logic Config from config.json (strategy.evaluator)
TAILOR_LOGIC = USER_CONFIG.get("strategy", {}).get("evaluator", {})
TAILOR_TOOLS = USER_CONFIG.get("tools", {}).get("resume_tailor", {})
PROMPT_TEMPLATE = TAILOR_TOOLS.get("prompt_template", "")

def categorize_activity(update_time):
    if not update_time: return '3_UNKNOWN'
    if any(k in update_time for k in ['今日', '本周', '刚刚', '小时']):
        return '1_HIGHLY_ACTIVE'
    day_match = re.search(r'(\d+)天前', update_time)
    if day_match:
        days = int(day_match.group(1))
        if days <= 15: return '1_HIGHLY_ACTIVE'
        elif days <= 30: return '2_RECENTLY_ACTIVE'
        else: return '4_LONG_INACTIVE'
    if re.search(r'\d+月\d+日', update_time): return '2_RECENTLY_ACTIVE'
    return '3_UNKNOWN'

def load_profile():
    # 1. From config.json (identity.profiles)
    config_paths = USER_CONFIG.get("identity", {}).get("profiles", [])
    
    # Combine (deduplicate while preserving order)
    all_paths = []
    seen = set()
    for p in config_paths:
        abs_p = os.path.expanduser(p)
        if abs_p not in seen:
            all_paths.append(abs_p)
            seen.add(abs_p)

    combined_profile = ""
    for p in all_paths:
        if os.path.exists(p):
            with open(p, 'r', encoding='utf-8') as f:
                combined_profile += f"\n--- {os.path.basename(p)} ---\n"
                combined_profile += f.read() + "\n\n"
    
    return combined_profile if combined_profile.strip() else "未找到候选人基础简历模板。"

def generate_tailored_resume(client, profile_text, job_title, job_company, job_desc, rationale):
    if not PROMPT_TEMPLATE:
        return "ERROR: No prompt template found in config."
        
    prompt = PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        job_title=job_title,
        job_company=job_company,
        job_desc=job_desc,
        rationale=rationale
    )
    
    try:
        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": "你是一个只输出 Markdown 的顶级高级猎头与简历改写专家。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        return f"AI 生成简历失败: {e}"

def create_job_doc(model="glm5", threshold=80, dry_run=False):
    try:
        model_map = {
            "gemma3": ("match_score", "rationale"),
            "qwen3_8b": ("match_score_qwen3_8b", "rationale_qwen3_8b"),
            "glm5": ("match_score_glm5", "rationale_glm5")
        }
        score_col, rationale_col = model_map.get(model, model_map["glm5"])
        
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        
        cur.execute(f"""
            SELECT id, title, company, salary, location, 
                   {score_col}, {rationale_col}, 
                   link, update_time, job_description
            FROM liepin_jobs
            WHERE {score_col} >= %s
              AND job_description NOT LIKE '[UNAVAILABLE%%'
            ORDER BY {score_col} DESC, fetched_at DESC
        """, (threshold,))
        jobs = cur.fetchall()
        
        activity_groups = defaultdict(list)
        for jb in jobs:
            act = categorize_activity(jb[8]) 
            activity_groups[act].append(jb)
            
        act_jobs = activity_groups.get("1_HIGHLY_ACTIVE", [])
        if not act_jobs:
            print("无极度活跃岗位。")
            return
            
        sorted_jobs = sorted(act_jobs, key=lambda x: x[5] or 0, reverse=True)
        top_5 = sorted_jobs[:5]
        
        client = OpenAI(api_key=API_KEY, base_url=API_BASE)
        profile_text = load_profile()
        
        # Path from config.json (storage.notes_dir)
        output_dir = os.path.expanduser(USER_CONFIG.get("storage", {}).get("notes_dir", "~/Documents/notes/jobs"))
        
        if dry_run:
            print(f"[DRY RUN] Would generate tailored resumes for {len(top_5)} highly active jobs.")
            print(f"[DRY RUN] Output directory: {output_dir}")
        else:
            os.makedirs(output_dir, exist_ok=True)
        
        print(f"找到 {len(top_5)} 个极度活跃岗位，开始生成定制简历...")
        
        for idx, job in enumerate(top_5, 1):
            jid, title, company, salary, location, score, rationale, link, update_time, jd = job
            company_str = company if company else "某企业"
            clean_title = re.sub(r'[\\/:*?"<>| ]', '_', title)
            folder_name = f"Resume_{idx:02d}_{clean_title[:15]}_{company_str[:10]}"
            folder_path = os.path.join(output_dir, folder_name)
            
            if dry_run:
                print(f"[DRY RUN] [{idx}/5] Would create folder and files for: {company_str} - {title}")
                continue

            os.makedirs(folder_path, exist_ok=True)
            
            # 1. 写 JD 解析文件
            jd_file = os.path.join(folder_path, "岗位分析.md")
            with open(jd_file, 'w', encoding='utf-8') as f:
                f.write(f"# {title} @ {company_str}\n\n")
                f.write(f"> 薪资：{salary} | 地点：{location} | 活跃度：{update_time}\n")
                f.write(f"> 链接：{link}\n\n---\n\n")
                f.write(f"## AI 评估详情 (Score: {score})\n\n")
                f.write(f"{rationale}\n")
                
            print(f"[{idx}/5] 正在生成专属简历: {company_str}...")
            
            tailored_resume = generate_tailored_resume(client, profile_text, title, company_str, jd, rationale)
            
            resume_file = os.path.join(folder_path, "定制简历.md")
            with open(resume_file, 'w', encoding='utf-8') as f:
                f.write(tailored_resume)
                
            print(f"      ✅ 完毕！")
            
    except Exception as e:
        print(f"生成失败: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate tailored resumes for high-score jobs.")
    parser.add_argument("--model", type=str, default="glm5", help="Model to use for scoring (gemma3, qwen3_8b, glm5)")
    parser.add_argument("--threshold", type=int, default=80, help="Minimum score threshold (default 80)")
    parser.add_argument("--dry-run", action="store_true", help="Run without writing to disk or DB")
    args = parser.parse_args()
    
    create_job_doc(model=args.model, threshold=args.threshold, dry_run=args.dry_run)
