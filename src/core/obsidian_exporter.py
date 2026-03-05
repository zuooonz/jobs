#!/usr/bin/env python3
import psycopg2
import os
import argparse
import json
from datetime import datetime
import re
from collections import defaultdict

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

# DB CONFIG from environment (Strict)
DB_CONFIG = {
    'dbname': get_env_strict('DB_NAME'),
    'user': get_env_strict('DB_USER'),
    'password': os.getenv('DB_PASSWORD', ''),
    'host': get_env_strict('DB_HOST'),
    'port': get_env_strict('DB_PORT')
}

def categorize_activity(update_time):
    if not update_time:
        return '3_UNKNOWN'
    if any(k in update_time for k in ['今日', '本周', '刚刚', '小时']):
        return '1_HIGHLY_ACTIVE'
    day_match = re.search(r'(\d+)天前', update_time)
    if day_match:
        days = int(day_match.group(1))
        if days <= 15:
            return '1_HIGHLY_ACTIVE'
        elif days <= 30:
            return '2_RECENTLY_ACTIVE'
        else:
            return '4_LONG_INACTIVE'
    if re.search(r'\d+月\d+日', update_time):
        return '2_RECENTLY_ACTIVE'
    return '3_UNKNOWN'

def smart_categorize(title, jd_text):
    """Dynamic categorization based on config.json"""
    text = f"{title} {jd_text}".lower()
    rules = USER_CONFIG.get("ui", {}).get("categorization_rules", [])
    for rule in rules:
        if any(k.lower() in text for k in rule.get("keywords", [])):
            return rule["id"]
    return "5_OTHER"

def parse_rationale_scores(rationale):
    """Extract dimension scores from rationale string"""
    if not rationale: return {}, ""
    try:
        match = re.search(r'\[hard_indicators.*?\]', rationale)
        if not match:
            return {}, rationale
            
        score_str = match.group(0)
        clean_rationale = rationale.replace(score_str, '').strip()
        
        scores = {}
        for item in score_str.strip('[]').split('|'):
            if ':' in item:
                k, v = item.split(':')
                scores[k.strip()] = int(v.strip())
        return scores, clean_rationale
    except Exception:
        return {}, rationale

def render_minimal_scores(rationale):
    """Compact rendering of dimension scores for Markdown"""
    s, clean_rationale = parse_rationale_scores(str(rationale))
    
    def get_circles(val, max_val):
        normalized = round((val / max_val) * 5) if val is not None else 0
        return '●' * normalized + '○' * (5 - normalized)

    dims = [
        ("硬标", s.get("hard_indicators", 0), 20),
        ("领域", s.get("domain_relevance", 0), 30),
        ("技术", s.get("technical_skills", 0), 30),
        ("项目", s.get("project_scenario", 0), 20)
    ]
    
    score_line = " | ".join([f"{label}: {get_circles(v, m)}" for label, v, m in dims])
    return f"`{score_line}`", clean_rationale

def render_job_block(f, job, include_jd=False):
    jid, title, company, salary, location, score, rationale, link, update_time, jd = job
    
    loc_str = location if location else "未知"
    time_str = update_time if update_time else "未知更新时间"
    company_str = company if company else "某企业"
    
    f.write(f"#### [{score}分] {title} - {company_str}\n")
    f.write(f"- 基本概况：{loc_str} | {salary} | {time_str} | [投递链接]({link})\n\n")
    
    score_line, clean_rationale = render_minimal_scores(rationale)
    f.write(f"{score_line}\n\n")
    
    if clean_rationale and clean_rationale.strip() != "None":
        f.write(f"> [!note] 深度分析\n")
        lines = clean_rationale.split('\n')
        for line in lines:
            line = line.strip()
            if not line or line.startswith("打分:") or line.startswith("理由:"):
                continue
            f.write(f"> {line}\n")
        f.write(">\n\n")
    
    if include_jd and jd:
        f.write(f"> [!quote]- 原始岗位描述\n")
        jd_lines = str(jd).split('\n')
        for line in jd_lines:
            f.write(f"> {line.strip()}\n")
        f.write(">\n\n")
    
    f.write("\n---\n\n")

def export_top_jobs(threshold=80, include_jd=False, model="glm5", dry_run=False, table_name="liepin_jobs"):
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
            FROM {table_name}
            WHERE {score_col} >= %s
              AND job_description NOT LIKE '[UNAVAILABLE%%'
            ORDER BY {score_col} DESC, fetched_at DESC
        """, (threshold,))
        
        jobs = cur.fetchall()
        
        if not jobs:
            print(f"没有找到 match_score >= {threshold} 且活跃的岗位。")
            cur.close()
            conn.close()
            return

        print(f"已锁定 {len(jobs)} 个顶级高分岗位。正在执行深维战略聚类...")
        
        clusters_info = USER_CONFIG.get("ui", {}).get("clusters", {})
        insights = USER_CONFIG.get("insights", {})
        
        clusters_data = defaultdict(list)
        for job in jobs:
            cat = smart_categorize(job[1], job[9]) 
            clusters_data[cat].append(job)
            
        # Path and Settings from config.json (storage.notes_dir)
        output_dir = os.path.expanduser(USER_CONFIG.get("storage", {}).get("notes_dir", "~/Documents/notes/jobs"))
        os.makedirs(output_dir, exist_ok=True)

        # Determine filename based on current time
        current_time = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filepath = os.path.join(output_dir, f"求职指南_{current_time}.md")
        
        if dry_run:
            print(f"[DRY RUN] Would generate report for {len(jobs)} jobs.")
            print(f"[DRY RUN] Target file: {filepath}")
            return

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("# 职位深度分析与决策指南\n\n")
            f.write("本报告采用单一模型评分体系，基于 `config.json` 的动态规则生成。\n\n---\n\n")
            
            # Sort clusters by alphabetical order or custom logic
            for cluster_id in sorted(clusters_info.keys()):
                cluster_jobs = clusters_data.get(cluster_id, [])
                if not cluster_jobs: continue
                
                f.write(f"## {clusters_info[cluster_id]}\n")
                f.write(f"统计：该领域包含 {len(cluster_jobs)} 个符合标准的职位\n\n")
                
                if cluster_id in insights:
                    f.write(insights[cluster_id])
                    f.write("\n---\n\n")
                
                activity_groups = defaultdict(list)
                for jb in cluster_jobs:
                    act = categorize_activity(jb[8]) 
                    activity_groups[act].append(jb)
                
                # Define ACTIVITY_TITLES here or ensure it's globally available
                ACTIVITY_TITLES = {
                    "1_HIGHLY_ACTIVE": "🚀 高度活跃",
                    "2_RECENTLY_ACTIVE": "✨ 近期活跃",
                    "3_UNKNOWN": "❓ 更新未知",
                    "4_LONG_INACTIVE": "💤 长期不活跃"
                }

                for act_key in ["1_HIGHLY_ACTIVE", "2_RECENTLY_ACTIVE", "3_UNKNOWN", "4_LONG_INACTIVE"]:
                    act_jobs = activity_groups.get(act_key, [])
                    if not act_jobs: continue
                    
                    f.write(f"### {ACTIVITY_TITLES[act_key]} ({len(act_jobs)} 岗)\n\n")
                    sorted_jobs = sorted(act_jobs, key=lambda x: x[5] or 0, reverse=True)
                    for c_job in sorted_jobs:
                        render_job_block(f, c_job, include_jd=include_jd)
                        
                f.write("\n")
                
        print(f"\n✅ 成功生成【顶级战略级求职指南】！共重整 {len(jobs)} 个火力点。")
        print(f"   简报已保存至: {filepath}")
        
    except Exception as e:
        print(f"导出失败: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()

if __name__ == "__main__":
    # Load user config for defaults
    CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        USER_CONFIG = json.load(f)

    default_threshold = USER_CONFIG.get("tools", {}).get("obsidian", {}).get("threshold", 80)
    parser = argparse.ArgumentParser(description="Export deeply analyzed job reports.")
    parser.add_argument("--threshold", type=int, default=default_threshold, help=f"最低分数阈值, 默认 {default_threshold}")
    parser.add_argument("--include-jd", "-j", action="store_true", help="是否包含岗位描述")
    parser.add_argument("--model", type=str, default="glm5", help="评分模型 (gemma3, qwen3_8b, glm5)")
    parser.add_argument("--dry-run", action="store_true", help="Run without writing files")
    parser.add_argument("--dataset", type=str, choices=["liepin", "boss"], default="liepin", help="Select which job dataset to process")
    args = parser.parse_args()
    
    table_name = f"{args.dataset}_jobs"
    export_top_jobs(args.threshold, args.include_jd, model=args.model, dry_run=args.dry_run, table_name=table_name)
