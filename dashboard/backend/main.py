import os
import psycopg2
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
try:
    from dotenv import load_dotenv
    # Load .env if it exists
    load_dotenv()
except ImportError:
    pass

app = FastAPI(title="Job Dashboard API")

# DB Config from environment variables
DB_CONFIG = {
    "dbname": os.getenv("DB_NAME", "jobs"),
    "user": os.getenv("DB_USER", "z"),
    "password": os.getenv("DB_PASSWORD", ""),
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 5432))
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class JobFeedback(BaseModel):
    user_score: Optional[int] = None
    user_notes: Optional[str] = None

import json

@app.get("/api/config")
def get_config():
    try:
        config_path = os.path.join(os.path.dirname(__file__), "..", "..", "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return config.get("ui", {})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/jobs")
def get_jobs(threshold: int = 80):
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        cur.execute("""
            SELECT id, title, company, salary, location, 
                   match_score_qwen3_8b, rationale_qwen3_8b,
                   link, update_time, job_description,
                   user_score, user_notes
            FROM liepin_jobs
            WHERE match_score_qwen3_8b >= %s
              AND job_description NOT LIKE '[UNAVAILABLE%%'
            ORDER BY match_score_qwen3_8b DESC, update_time DESC NULLS LAST
        """, (threshold,))
        
        jobs = []
        rows = cur.fetchall()
        for row in rows:
            jobs.append({
                "id": row[0],
                "title": row[1],
                "company": row[2],
                "salary": row[3],
                "location": row[4],
                "score": row[5],
                "rationale": row[6],
                "link": row[7],
                "update_time": row[8],
                "jd": row[9],
                "user_score": row[10],
                "user_notes": row[11]
            })
            
        cur.close()
        conn.close()
        return jobs
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/jobs/{job_id}/feedback")
def update_feedback(job_id: int, feedback: JobFeedback):
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cur = conn.cursor()
        cur.execute("""
            UPDATE liepin_jobs 
            SET user_score = %s, user_notes = %s
            WHERE id = %s
        """, (feedback.user_score, feedback.user_notes, job_id))
        conn.commit()
        cur.close()
        conn.close()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("BACKEND_HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_PORT", 8888))
    uvicorn.run(app, host=host, port=port)
