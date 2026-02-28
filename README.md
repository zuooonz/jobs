# Job AI Dashboard & Scraper Suite

## Vibe Coding Experiment
This project is a result of a **"Vibe Coding"** experiment—a deep collaboration between a human developer (defining intent and aesthetics) and an AI agent (handling engineering and complexity). 

---

## 🧪 Live Demo
[点击查看在线演示网页](https://zuooonz.github.io/jobs/)

A comprehensive toolset for scraping, evaluating, and visualizing job opportunities from Liepin.com, powered by Local LLMs (Ollama/vLLM) for intelligent scoring.

## Features

- **Automated Scraper**: Multi-mode scraping (Puppeteer) to fetch and deduplicate job data.
- **AI Evaluation**: Grade jobs based on your custom profile using models like **Gemma 3** or **Qwen 3**.
- **Interactive Dashboard**: A modern, Twitter-inspired web interface to browse, filter, and rate jobs.
- **Obsidian Integration**: Export high-scoring jobs and tailored resumes directly into your notes.

## Project Structure

```text
.
├── src/
│   ├── scrapers/            # JS Scrapers (Puppeteer)
│   │   ├── fetch-list.js    # Primary job list scraper
│   │   └── fetch-details.js # Job description scraper
│   └── core/                # Python Logic (LLM & Rules)
│       ├── job_filter.py    # Rule-based filtering
│       ├── job_evaluator.py # AI scoring & evaluation
│       └── resume_tailor.py # Custom resume generation
├── config.json         # Unified configuration (Keywords, Blacklist, AI Rubric, UI)
├── .jobs_state.json     # Hidden machine state (Auto-generated)
├── .env                # Database credentials (Secret)
├── dashboard/               # Web Application (React + FastAPI)
└── .env.example             # Environment Configuration Template
```

## Setup Instructions

### 1. Prerequisites
- **Python 3.10+**
- **Node.js 18+**
- **PostgreSQL**
- **Ollama** or **vLLM** (for AI scoring)

### 2. Python Environment
```bash
pip install -r requirements.txt
```

### 3. Frontend & Node Dependencies
   ```bash
   npm install
   cd dashboard/frontend && npm install
   ```

## Configuration & Personalization

The project is now ultra-minimalist. All user settings are in a single root file.

### 1. Unified Configuration (`config.json`)
- **Scraper**: Define search `keywords`, `batch_size`, and `city`.
- **Filter**: Set `black_keywords`, `min_salary`, and `target_cities`.
- **Evaluator**: Configure the AI scoring `prompt_template`, `hard_blacklist`, and `user_profile_paths`.
- **UI**: Customize categorization `clusters` and keyword-based `rules`.
- **Tools**: Settings for Obsidian export and Resume tailoring.

### 2. Machine State (`.jobs_state.json`)
- This is a hidden file automatically managed by the scraper to track progress. If deleted, the scraper will simply restart from the first keyword. **No manual editing required.**

1. Copy the environment templates:
   ```bash
   cp .env.example .env
   cp config.json.example config.json
   ```
2. Edit `.env` with your database credentials and AI API endpoints.
3. Personalize `config.json` with your search keywords and AI rubric.

### 4. Running the Dashboard
Use the provided management script:
```bash
cd dashboard
./manage.sh start
```
The dashboard will be available at `http://localhost:5175`.

### 5. Standard Workflow
Run these from the root directory using `npm run`:
- **Step 1: Fetch Lists**: `npm run fetch`
- **Step 2: Filter Data**: `npm run filter`
- **Step 3: Fetch Details**: `npm run fetch:details`
- **Step 4: AI Evaluate**: `npm run evaluate`
- **Step 5: Export Reports**: `npm run export`
- **Step 6: Gen Resumes**: `npm run tailor`

## License
MIT
