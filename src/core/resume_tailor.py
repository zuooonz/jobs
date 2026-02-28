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

# Load user config
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    USER_CONFIG = json.load(f)

# DB CONFIG
DB_CONFIG = {
    'dbname': os.getenv('DB_NAME', 'jobs'),
    'user': os.getenv('DB_USER', 'z'),
    'password': os.getenv('DB_PASSWORD', ''),
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432')
}

# Connection Config from .env (Higher priority for infrastructure)
API_BASE = os.getenv("GEMMA_API_BASE", "http://localhost:11434/v1")
API_KEY = os.getenv("GEMMA_API_KEY", "ollama")
MODEL_NAME = os.getenv("GEMMA_MODEL_NAME", "gemma3:12b-it-qat")

# Logic Config from config.json
TAILOR_CONFIG = USER_CONFIG.get("tools", {}).get("resume_tailor", {})
PROMPT_TEMPLATE = TAILOR_CONFIG.get("prompt_template", "")

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
    # 1. From .env (Higher priority, support multiple comma-separated paths)
    env_profiles = os.getenv("RESUME_PROFILE_PATH", "")
    env_paths = [p.strip() for p in env_profiles.split(",") if p.strip()]
    
    # 2. From config.json
    config_paths = USER_CONFIG.get("evaluator", {}).get("user_profile_paths", [])
    
    # Combine (deduplicate while preserving order, env first)
    all_paths = []
    seen = set()
    for p in env_paths + config_paths:
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

def create_job_doc():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        
        cur.execute("""
            SELECT id, title, company, salary, location, 
                   match_score_qwen3_8b, rationale_qwen3_8b, 
                   link, update_time, job_description
            FROM liepin_jobs
            WHERE match_score_qwen3_8b >= 80
              AND job_description NOT LIKE '[UNAVAILABLE%%'
            ORDER BY match_score_qwen3_8b DESC, fetched_at DESC
        """)
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
        
        # Path from .env (infra)
        output_dir = os.path.expanduser(os.getenv("JOBS_NOTES_DIR", "~/Documents/notes/jobs"))
        os.makedirs(output_dir, exist_ok=True)
        
        print(f"找到 {len(top_5)} 个极度活跃岗位，开始生成定制简历...")
        
        for idx, job in enumerate(top_5, 1):
            jid, title, company, salary, location, score, rationale, link, update_time, jd = job
            company_str = company if company else "某企业"
            clean_title = re.sub(r'[\\/:*?"<>| ]', '_', title)
            folder_name = f"Resume_{idx:02d}_{clean_title[:15]}_{company_str[:10]}"
            folder_path = os.path.join(output_dir, folder_name)
            
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
    create_job_doc()
