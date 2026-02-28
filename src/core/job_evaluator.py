import json
import os
import psycopg2
import argparse
from openai import OpenAI
import time
import re

# Load environment variables if available
try:
    from dotenv import load_dotenv
    # Load .env if it exists
    load_dotenv()
except ImportError:
    pass

# 数据库配置
DB_CONFIG = {
    "dbname": os.getenv("DB_NAME", "jobs"),
    "user": os.getenv("DB_USER", "z"),
    "password": os.getenv("DB_PASSWORD", ""),
    "host": os.getenv("DB_HOST", "localhost"),
    "port": os.getenv("DB_PORT", "5432")
}

# 模型配置集
MODEL_CONFIGS = {
    "gemma3": {
        "api_base": os.getenv("GEMMA_API_BASE", "http://localhost:11434/v1"),
        "api_key": os.getenv("GEMMA_API_KEY", "ollama"),
        "model_name": os.getenv("GEMMA_MODEL_NAME", "gemma3:12b-it-qat"),
        "score_col": "match_score",
        "rationale_col": "rationale"
    },
    "qwen3_8b": {
        "api_base": os.getenv("QWEN_API_BASE", "http://localhost:8000/v1"),
        "api_key": os.getenv("QWEN_API_KEY", "vllm"),
        "model_name": os.getenv("QWEN_MODEL_NAME", "Qwen/Qwen3-8B-AWQ"),
        "score_col": "match_score_qwen3_8b",
        "rationale_col": "rationale_qwen3_8b"
    }
}

# Load user config
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    USER_CONFIG = json.load(f)

HARD_BLACKLIST = USER_CONFIG["evaluator"]["hard_blacklist"]
PROMPT_TEMPLATE = USER_CONFIG["evaluator"]["prompt_template"]

def get_db_connection():
    return psycopg2.connect(**DB_CONFIG)

def check_model_availability(api_key, base_url):
    try:
        client = OpenAI(
            api_key=api_key, # Not strictly validated for vLLM
            base_url=base_url
        )
        return client.models.list()
    except Exception as e:
        return None

def load_profile(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def evaluate_job(client, model_name, profile_text, job_title, job_company, job_salary, job_desc):
    # Use dynamic prompt from config
    prompt = PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        job_title=job_title,
        job_company=job_company,
        job_salary=job_salary,
        job_desc=job_desc
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # First attempt: strict temperature. Later attempts: inject randomness to escape collapse
            temp = 0.1 if attempt == 0 else (0.5 + attempt * 0.2)
            pres_pen = 0.0 if attempt == 0 else 0.5
            
            response = client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": "你是一个只输出 JSON 格式的高级 HR 匹配评估引擎。"},
                    {"role": "user", "content": prompt}
                ],
                temperature=temp,
                presence_penalty=pres_pen,
                max_tokens=2000,
            )
            
            import re
            content = response.choices[0].message.content.strip()
            
            # 提取第一个 { 到最后一个 } 之间的内容
            match = re.search(r'(\{.*\})', content, re.DOTALL)
            if match:
                json_str = match.group(1)
            else:
                json_str = content
                
            try:
                result = json.loads(json_str, strict=False)
            except Exception as json_e:
                if attempt < max_retries - 1:
                    print(f"  [Attempt {attempt+1}] JSON解析异常，正使用更高 temperature 重试...")
                    continue
                else:
                    print(f"[JSON Decode Error] Raw Content from LLM:\n{content}\n")
                    raise json_e
            
            score = result.get("score")
            analysis = result.get("analysis", "")
            reason = result.get("reason", "")
            
            # Combine dimension scores into the rationale if available
            dim_scores = result.get("dimension_scores")
            if dim_scores and isinstance(dim_scores, dict):
                breakdown = " | ".join([f"{k}: {v}" for k, v in dim_scores.items()])
                full_reason = f"[{breakdown}]\n思考链路: {analysis}\n总结: {reason}"
            else:
                full_reason = f"思考: {analysis}\n总结: {reason}"
                
            return score, full_reason
            
        except Exception as e:
            if attempt < max_retries - 1:
                print(f"  [Attempt {attempt+1}] API调用异常 ({e})，正在重试...")
            else:
                print(f"LLM 评估出错: {e}")
                return None, None

def apply_static_filters_globally(conn):
    """
    全量扫描并同步所有模型的静态过滤分数。
    1. 判断是否命中下线或黑名单。
    2. 如果命中，确保 match_score 和 match_score_qwen3_8b 均为 0。
    3. 如果均不命中且曾被关键词过滤，则释放（设为 NULL）。
    """
    cur = conn.cursor()
    cur.execute("SELECT id, title, job_description, match_score, rationale, match_score_qwen3_8b, rationale_qwen3_8b FROM liepin_jobs WHERE job_description IS NOT NULL")
    all_jobs = cur.fetchall()
    
    updates = []
    for j_id, title, job_desc, s1, r1, s2, r2 in all_jobs:
        desc_upper = job_desc.upper()
        title_upper = title.upper()
        
        target_score = None
        target_rationale = None
        
        # --- 决策树 ---
        # A. 状态下线
        if any(mark in desc_upper for mark in ["[UNAVAILABLE", "[JD_UNAVAILABLE"]):
            target_score = 0
            target_rationale = "后置过滤，暂停招聘"
        # B. 命中黑名单关键词
        else:
            for toxic in HARD_BLACKLIST:
                if toxic.upper() in title_upper or toxic.upper() in desc_upper:
                    target_score = 0
                    target_rationale = f"后置过滤，根据具体过滤关键词：{toxic}"
                    break
        
        # --- 同步逻辑 (针对双模型列) ---
        needs_update = False
        # 场景 A: 判定为应拦截 (0分)
        if target_score == 0:
            # 只要任意一个模型的列没有同步为 0 或理由不符，就更新
            if s1 != 0 or r1 != target_rationale or s2 != 0 or r2 != target_rationale:
                needs_update = True
        # 场景 B: 判定为应释放 (None)
        else:
            # 只要任意一个模型列之前是被“后置过滤”标记的，就全部重置
            if (r1 and r1.startswith("后置过滤，")) or (r2 and r2.startswith("后置过滤，")):
                needs_update = True

        if needs_update:
            updates.append((target_score, target_rationale, target_score, target_rationale, j_id))
                
    if updates:
        import psycopg2.extras
        psycopg2.extras.execute_batch(cur, """
            UPDATE liepin_jobs 
            SET match_score = %s, rationale = %s, 
                match_score_qwen3_8b = %s, rationale_qwen3_8b = %s 
            WHERE id = %s
        """, updates)
        conn.commit()
    cur.close()
    return updates

def main():
    parser = argparse.ArgumentParser(description="Evaluate jobs using local LLM")
    parser.add_argument("--test-run", type=int, default=0, help="Evaluate N jobs for testing")
    parser.add_argument("--model", type=str, default="qwen3_8b", choices=["gemma3", "qwen3_8b"], help="Select evaluation model")
    args = parser.parse_args()

    config = MODEL_CONFIGS[args.model]
    test_mode = args.test_run > 0
    batch_limit = args.test_run if test_mode else 500

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

    profile_text = ""
    for p in all_paths:
        if os.path.exists(p):
            profile_text += f"\n--- {os.path.basename(p)} ---\n"
            profile_text += load_profile(p)
            
    if not profile_text.strip():
        print("没有找到简历文件。")
        return
    
    profile_text = profile_text[:15000]

    client = OpenAI(api_key=config["api_key"], base_url=config["api_base"])
    conn = get_db_connection()

    try:
        # 1. 同步全量静态过滤
        static_updates = apply_static_filters_globally(conn)
        
        cur = conn.cursor()
        # 2. 查找所选模型尚未评估的岗位
        score_col = config["score_col"]
        cur.execute(f"""
            SELECT id, title, company, salary, job_description 
            FROM liepin_jobs 
            WHERE job_description IS NOT NULL AND {score_col} IS NULL 
            ORDER BY fetched_at DESC LIMIT %s
        """, (batch_limit,))
        
        jobs = cur.fetchall()
        
        success_count = 0
        if not jobs:
            print(f"目前没有待 [{args.model}] 评估的新鲜职位。")
        else:
            print(f"\n使用模型: {args.model} ({config['model_name']})")
            print(f"找到本批次 {len(jobs)} 个待评估职位...")
            
            for job_id, title, company, salary, desc in jobs:
                print(f"正在评估 [{job_id}] {company} - {title} ...")
                short_desc = desc[:3000] if desc else ""
                score, reason = evaluate_job(client, config["model_name"], profile_text, title, company, salary, short_desc)
                
                if score is not None and reason is not None:
                    print(f" -> 分数: {score}")
                    if not test_mode:
                        try:
                            cur.execute(f"UPDATE liepin_jobs SET {score_col} = %s, {config['rationale_col']} = %s WHERE id = %s", (score, reason, job_id))
                            conn.commit()
                            success_count += 1
                        except Exception as e:
                            conn.rollback()
                            print(f" -> 更新失败: {e}")
                else:
                    print(" -> 失败，跳过。")

        cur.close()

        print("\n================= 运行报告 ==================")
        print(f"✅ 后置静态同步: 更新了 {len(static_updates)} 个岗位。")
        print(f"✅ [{args.model}] 评估: 写入了 {success_count} 个新岗位。")
        print("=============================================\n")

    finally:
        conn.close()

if __name__ == "__main__":
    main()
