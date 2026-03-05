#!/usr/bin/env python3
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

def get_env_strict(key):
    val = os.getenv(key)
    if val is None:
        raise EnvironmentError(f"Missing required environment variable: {key}")
    return val

# 数据库配置
DB_CONFIG = {
    "dbname": get_env_strict("DB_NAME"),
    "user": get_env_strict("DB_USER"),
    "password": os.getenv("DB_PASSWORD", ""),
    "host": get_env_strict("DB_HOST"),
    "port": get_env_strict("DB_PORT")
}

# 模型配置集
MODEL_CONFIGS = {
    "gemma3": {
        "api_base": get_env_strict("GEMMA_API_BASE"),
        "api_key": get_env_strict("GEMMA_API_KEY"),
        "model_name": get_env_strict("GEMMA_MODEL_NAME"),
        "score_col": "match_score",
        "rationale_col": "rationale"
    },
    "qwen3_8b": {
        "api_base": get_env_strict("QWEN_API_BASE"),
        "api_key": get_env_strict("QWEN_API_KEY"),
        "model_name": get_env_strict("QWEN_MODEL_NAME"),
        "score_col": "match_score_qwen3_8b",
        "rationale_col": "rationale_qwen3_8b"
    },
    "glm5": {
        "api_base": get_env_strict("GLM_API_BASE"),
        "api_key": get_env_strict("GLM_API_KEY"),
        "model_name": get_env_strict("GLM_MODEL_NAME"),
        "score_col": "match_score_glm5",
        "rationale_col": "rationale_glm5"
    }
}

# Load user config
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    USER_CONFIG = json.load(f)

HARD_BLACKLIST = USER_CONFIG.get("strategy", {}).get("evaluator", {}).get("hard_blacklist", [])
PROMPT_TEMPLATE = USER_CONFIG.get("strategy", {}).get("evaluator", {}).get("prompt_template", "")

def get_db_connection():
    return psycopg2.connect(**DB_CONFIG)

def check_model_availability(api_key, base_url):
    try:
        client = OpenAI(
            api_key=api_key,
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

def apply_static_filters_globally(conn, dry_run=False, table_name="liepin_jobs"):
    """
    全量扫描并同步所有模型的静态过滤分数。
    """
    cur = conn.cursor()
    
    # 动态构建查询列，确保包含所有配置的列
    cols_to_select = ["id", "title", "job_description"]
    model_keys = list(MODEL_CONFIGS.keys())
    for key in model_keys:
        cols_to_select.append(MODEL_CONFIGS[key]["score_col"])
        cols_to_select.append(MODEL_CONFIGS[key]["rationale_col"])
    
    query = f"SELECT {', '.join(cols_to_select)} FROM {table_name} WHERE job_description IS NOT NULL"
    cur.execute(query)
    all_jobs = cur.fetchall()
    
    updates = []
    for row in all_jobs:
        j_id = row[0]
        title = row[1]
        job_desc = row[2]
        # 模型数据从索引 3 开始，成对出现 (score, rationale)
        model_data = row[3:]
        
        desc_upper = job_desc.upper()
        title_upper = title.upper()
        
        target_score = None
        target_rationale = None
        
        # --- 决策树 ---
        if any(mark in desc_upper for mark in ["[UNAVAILABLE", "[JD_UNAVAILABLE"]):
            target_score = 0
            target_rationale = "后置过滤，暂停招聘"
        else:
            for toxic in HARD_BLACKLIST:
                if toxic.upper() in title_upper or toxic.upper() in desc_upper:
                    target_score = 0
                    target_rationale = f"后置过滤，根据具体过滤关键词：{toxic}"
                    break
        
        # --- 同步逻辑 (针对全量模型列) ---
        needs_update = False
        if target_score == 0:
            # 只要任意一个模型的列没有同步为 0 或理由不符，就更新全部
            for i in range(0, len(model_data), 2):
                if model_data[i] != 0 or model_data[i+1] != target_rationale:
                    needs_update = True
                    break
        else:
            # 只要任意一个模型列之前是被“后置过滤”标记的，就全部重置
            for i in range(1, len(model_data), 2):
                if model_data[i] and model_data[i].startswith("后置过滤，"):
                    needs_update = True
                    break

        if needs_update:
            # 构建更新参数列表: [score1, rationale1, score2, rationale2, ..., id]
            update_row = []
            for _ in model_keys:
                update_row.extend([target_score, target_rationale])
            update_row.append(j_id)
            updates.append(tuple(update_row))
                
    if updates:
        if dry_run:
            print(f"[DRY RUN] Would update static filters for {len(updates)} jobs.")
        else:
            # 动态构建 UPDATE 语句
            set_clauses = []
            for key in model_keys:
                set_clauses.append(f"{MODEL_CONFIGS[key]['score_col']} = %s")
                set_clauses.append(f"{MODEL_CONFIGS[key]['rationale_col']} = %s")
            
            update_query = f"UPDATE {table_name} SET {', '.join(set_clauses)} WHERE id = %s"
            
            import psycopg2.extras
            psycopg2.extras.execute_batch(cur, update_query, updates)
            conn.commit()
    cur.close()
    return updates

def main():
    parser = argparse.ArgumentParser(description="Evaluate jobs using local LLM")
    parser.add_argument("--dry-run", action="store_true", help="Run without writing to database")
    parser.add_argument("--test-run", type=int, default=0, help="Evaluate N jobs for testing (implies --dry-run)")
    parser.add_argument("--model", type=str, default="glm5", choices=["gemma3", "qwen3_8b", "glm5"], help="Select evaluation model")
    parser.add_argument("--dataset", type=str, choices=["liepin", "boss"], default="liepin", help="Select which job dataset to process")
    args = parser.parse_args()

    # Aliasing --test-run logic to use dry-run internally
    dry_run = args.dry_run or args.test_run > 0
    batch_limit = args.test_run if args.test_run > 0 else 500
    table_name = f"{args.dataset}_jobs"

    config = MODEL_CONFIGS[args.model]

    # 1. From config.json (Now in identity.profiles)
    config_paths = USER_CONFIG.get("identity", {}).get("profiles", [])
    
    # Combine (deduplicate while preserving order)
    all_paths = []
    seen = set()
    for p in config_paths:
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
        static_updates = apply_static_filters_globally(conn, dry_run=dry_run, table_name=table_name)
        
        cur = conn.cursor()
        # 2. 查找所选模型尚未评估的岗位
        score_col = config["score_col"]
        cur.execute(f"""
            SELECT id, title, company, salary, job_description 
            FROM {table_name}
            WHERE job_description IS NOT NULL AND {score_col} IS NULL 
            ORDER BY fetched_at DESC LIMIT %s
        """, (batch_limit,))
        
        jobs = cur.fetchall()
        
        success_count = 0
        if not jobs:
            print(f"目前没有待 [{args.model}] 评估的新鲜职位。")
        else:
            print(f"\n使用模型: {args.model} ({config['model_name']})")
            if dry_run: print("[DRY RUN MODE] Changes will not be saved to database.")
            print(f"找到本批次 {len(jobs)} 个待评估职位...")
            
            for job_id, title, company, salary, desc in jobs:
                print(f"正在评估 [{job_id}] {company} - {title} ...")
                short_desc = desc[:3000] if desc else ""
                score, reason = evaluate_job(client, config["model_name"], profile_text, title, company, salary, short_desc)
                
                if score is not None and reason is not None:
                    print(f" -> 分数: {score}")
                    if not dry_run:
                        try:
                            cur.execute(f"UPDATE {table_name} SET {score_col} = %s, {config['rationale_col']} = %s WHERE id = %s", (score, reason, job_id))
                            conn.commit()
                            success_count += 1
                        except Exception as e:
                            conn.rollback()
                            print(f" -> 更新失败: {e}")
                    else:
                        success_count += 1
                else:
                    print(" -> 失败，跳过。")

        cur.close()

        print("\n================= 运行报告 ==================")
        print(f"✅ 后置静态同步: {'(模拟)' if dry_run else ''}更新了 {len(static_updates)} 个岗位。")
        print(f"✅ [{args.model}] 评估: {'(模拟)' if dry_run else ''}处理了 {success_count} 个新岗位。")
        print("=============================================\n")

    finally:
        conn.close()

if __name__ == "__main__":
    main()
