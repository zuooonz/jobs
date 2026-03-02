import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import demoJobs from './demo_jobs.json';
import demoConfig from './demo_config.json';

const ACTIVITY_TIERS = {
  "1_HIGHLY_ACTIVE": {
    title: "高频活跃",
    desc: "两周内更新",
    criteria: "更新时间：刚刚、今日、本周或 15 天内",
    color: "var(--color-high)"
  },
  "2_RECENTLY_ACTIVE": {
    title: "近期活跃",
    desc: "一月内更新",
    criteria: "更新时间：16-30 天内，或标明具体月日",
    color: "var(--color-recent)"
  },
  "3_UNKNOWN": {
    title: "活跃未知",
    desc: "时间不详",
    criteria: "未获取到具体更新时间或格式不符",
    color: "var(--color-unknown)"
  },
  "4_LONG_INACTIVE": {
    title: "较低活跃",
    desc: "一个月以上",
    criteria: "更新时间：超过 30 天",
    color: "var(--color-inactive)"
  }
};

// Premium minimalist icons (SVG)
const Icons = {
  Location: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>
  ),
  Salary: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
  ),
  Time: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
  ),
  ChevronDown: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
  ),
  ChevronRight: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
  ),
  Menu: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
  ),
  Close: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
  ),
  Mail: () => (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
  )
};

// API Configuration
// If current hostname is NOT localhost, we should probably prefer it over the env-configured localhost
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL && !import.meta.env.VITE_API_BASE_URL.includes('localhost'))
  ? import.meta.env.VITE_API_BASE_URL
  : `http://${window.location.hostname}:8888`;

function App() {
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState({ clusters: {}, categorization_rules: [] });
  const [isDemo, setIsDemo] = useState(false);
  const [activeCluster, setActiveCluster] = useState("");
  const [activeTier, setActiveTier] = useState("");
  const [statusFilter, setStatusFilter] = useState('all');
  const [scoreThreshold, setScoreThreshold] = useState(75);
  const [scoreSource, setScoreSource] = useState('glm5');
  const [sortOrder, setSortOrder] = useState('desc');
  const [expandAll, setExpandAll] = useState(window.innerWidth > 768);
  const [connectionError, setConnectionError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const contentRef = useRef(null);
  const jobListRef = useRef(null);
  const touchStartRef = useRef(null);
  const debounceTimerRef = useRef(null);

  const isGithubPages = window.location.hostname.endsWith('github.io');

  // Helper for fetch with timeout
  const fetchWithTimeout = async (resource, options = {}) => {
    const { timeout = 5000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(resource, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return resp;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  };

  const fetchJobs = async () => {
    if (isGithubPages) {
      setJobs(demoJobs);
      setIsDemo(true);
      return;
    }

    try {
      setLoading(true);
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/jobs?threshold=${scoreThreshold}&model=${scoreSource}`);
      if (!response.ok) throw new Error('Network response not ok');
      const data = await response.json();
      setJobs(data);
      setIsDemo(false);
      setConnectionError(false);
    } catch (error) {
      console.warn('Backend reach failed. Falling back to offline data.');
      setJobs(demoJobs);
      setIsDemo(true); // Show Demo banner even in local mode if backend is unreachable
      setConnectionError(true);
    } finally {
      setLoading(false);
    }
  };

  const fetchConfig = async () => {
    if (isGithubPages) {
      const normalized = demoConfig.ui ? { ...demoConfig, ...demoConfig.ui } : demoConfig;
      setConfig(normalized);
      return;
    }

    try {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/config`);
      if (!response.ok) throw new Error('Network response not ok');
      const data = await response.json();
      const normalized = data.ui ? { ...data, ...data.ui } : data;
      setConfig(normalized);
    } catch (error) {
      console.warn('Backend reaches failed. Falling back to local demo config.');
      const normalized = demoConfig.ui ? { ...demoConfig, ...demoConfig.ui } : demoConfig;
      setConfig(normalized);
      setIsDemo(true);
    }
  };

  const initialize = async () => {
    console.log('Initializing app...');
    setLoading(true);
    setConnectionError(false);

    try {
      await Promise.all([fetchJobs(), fetchConfig()]);
    } catch (err) {
      console.error('Initialization error:', err);
    } finally {
      console.log('Initialization complete.');
      setLoading(false);
    }
  };

  useEffect(() => {
    initialize();
  }, []);

  // Effect to handle dynamic updates for source/threshold
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetchJobs();
    }, 400);
  }, [scoreSource, scoreThreshold]);

  // Placeholder for future stable mobile interactions

  // Dynamic categorization logic
  const smartCategorize = useCallback((title, jd) => {
    const text = (title + (jd || '')).toLowerCase();
    if (!config.categorization_rules) return "5_OTHER";
    for (const rule of config.categorization_rules) {
      if (rule.keywords.some(kw => text.includes(kw.toLowerCase()))) {
        return rule.id;
      }
    }
    return "5_OTHER";
  }, [config.categorization_rules]);

  const categorizeActivity = useCallback((updateTime) => {
    if (!updateTime) return '3_UNKNOWN';
    const text = updateTime;
    if (text.includes('今日') || text.includes('本周') || text.includes('刚刚') || text.includes('小时')) return '1_HIGHLY_ACTIVE';

    const dayMatch = /(\d+)天前/.exec(text);
    if (dayMatch) {
      const days = parseInt(dayMatch[1]);
      if (days <= 15) return '1_HIGHLY_ACTIVE';
      if (days <= 30) return '2_RECENTLY_ACTIVE';
      return '4_LONG_INACTIVE';
    }

    if (/\d+月\d+日/.test(text)) {
      return '2_RECENTLY_ACTIVE';
    }

    return '3_UNKNOWN';
  }, []);

  const processedJobs = useMemo(() => {
    return jobs.map(job => ({
      ...job,
      _cluster: smartCategorize(job.title, job.jd),
      _tier: categorizeActivity(job.update_time),
      _isRated: (job.user_score || 0) > 0
    }));
  }, [jobs, smartCategorize, categorizeActivity]);

  const filteredJobs = useMemo(() => {
    let result = processedJobs.filter(job => {
      const clusterMatch = !activeCluster || job._cluster === activeCluster;
      const tierMatch = !activeTier || activeTier === 'all' || job._tier === activeTier;

      if (!(clusterMatch && tierMatch)) return false;

      if (statusFilter === 'rated') return job._isRated;
      if (statusFilter === 'unrated') return !job._isRated;
      return true;
    });

    // Apply Client-side sorting
    return [...result].sort((a, b) => {
      if (sortOrder === 'desc') return (b.score || 0) - (a.score || 0);
      return (a.score || 0) - (b.score || 0);
    });
  }, [processedJobs, activeCluster, activeTier, statusFilter, sortOrder]);

  // Handle local feedback updates
  const handleLocalUpdate = useCallback((jobId, newScore, newNotes) => {
    setJobs(prevJobs => prevJobs.map(job =>
      job.id === jobId ? { ...job, user_score: newScore, user_notes: newNotes } : job
    ));
  }, []);

  // Effects (defined after dependencies)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo(0, 0);
    }
    if (jobListRef.current) {
      jobListRef.current.scrollTo(0, 0); // Reset for mobile horizontal snap context
    }
  }, [activeCluster, activeTier, statusFilter]);

  // Removed auto-selection effect to respect "Show All" default

  return (
    <>
      {/* Mobile Backdrop */}
      {isSidebarOpen && <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />}

      <div className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <span>职位数据看板</span>
          <button className="mobile-close-btn" onClick={() => setIsSidebarOpen(false)}>
            <Icons.Close />
          </button>
        </div>
        <div className="sidebar-nav">
          {Object.entries(config.clusters || {}).map(([clusterId, clusterTitle]) => {
            // Check if any sub-tier has items to potentially hide the entire cluster group if needed
            // But usually we just hide sub-items
            return (
              <div key={clusterId} className="nav-group">
                <div
                  className={`nav-group-title ${activeCluster === clusterId && activeTier === 'all' ? 'active' : ''}`}
                  onClick={() => {
                    if (activeCluster === clusterId && (activeTier === 'all' || activeTier === '')) {
                      setActiveCluster("");
                      setActiveTier("");
                    } else {
                      setActiveCluster(clusterId);
                      setActiveTier('all');
                    }
                  }}
                  style={{ cursor: 'pointer', transition: 'color 0.2s' }}
                >
                  {clusterTitle}
                </div>
                {Object.entries(ACTIVITY_TIERS).map(([tierId, info]) => {
                  const items = processedJobs.filter(j => j._cluster === clusterId && j._tier === tierId);
                  const count = items.length;
                  if (count === 0) return null;

                  return (
                    <div
                      key={tierId}
                      className={`nav-sub-item ${activeCluster === clusterId && activeTier === tierId ? 'active' : ''}`}
                      onClick={() => {
                        if (activeCluster === clusterId && activeTier === tierId) {
                          setActiveCluster("");
                          setActiveTier("");
                        } else {
                          setActiveCluster(clusterId);
                          setActiveTier(tierId);
                        }
                        setIsSidebarOpen(false); // Close on mobile selection
                      }}
                    >
                      <span className="nav-sub-item-label">{info.title}</span>
                      <span className="nav-sub-item-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div className="sidebar-filters-mobile" style={{ marginTop: '24px', borderTop: '1px solid var(--border)', paddingTop: '24px' }}>
            <div style={{ padding: '0 16px', marginBottom: '16px', fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700 }}>展示设置</div>

            <div className="filter-group" style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Mobile Score Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>模型评分</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--accent)' }}>{scoreThreshold}+</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  className="custom-slider"
                  value={scoreThreshold}
                  onChange={(e) => setScoreThreshold(parseInt(e.target.value))}
                  style={{
                    width: '100%',
                    margin: 0,
                    background: `linear-gradient(to right, var(--accent) ${scoreThreshold}%, rgba(255, 255, 255, 0.1) ${scoreThreshold}%)`
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>人工评分</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['all', 'unrated', 'rated'].map(f => (
                    <button
                      key={f}
                      className={`filter-btn-mobile ${statusFilter === f ? 'active' : ''}`}
                      onClick={() => setStatusFilter(f)}
                    >
                      {f === 'all' ? '全部' : f === 'unrated' ? '未处理' : '已评分'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>视图模式</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className={`filter-btn-mobile ${!expandAll ? 'active' : ''}`} onClick={() => setExpandAll(false)}>全部收起</button>
                  <button className={`filter-btn-mobile ${expandAll ? 'active' : ''}`} onClick={() => setExpandAll(true)}>全部展开</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="main-content" ref={contentRef}>
        {isDemo && (
          <div className="demo-banner">
            <div className="demo-banner-content">
              <span className="demo-tag">DEMO MODE</span>
              <p>当前运行在静态演示模式。数据来自预导出的 <code>demo_jobs.json</code>，并非实时后端数据。</p>
            </div>
          </div>
        )}
        {connectionError && !isGithubPages && (
          <div className="demo-banner" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: '#ef4444' }}>
            <div className="demo-banner-content">
              <span className="demo-tag" style={{ background: '#ef4444' }}>OFFLINE</span>
              <p>无法连接到本地后端。当前显示的是本地缓存的演示数据。</p>
            </div>
          </div>
        )}
        <div className="header">
          <div className="mobile-header">
            <button className="menu-toggle" onClick={() => setIsSidebarOpen(true)}>
              <Icons.Menu />
            </button>
            <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>职位数据看板</span>
          </div>
          <div className="header-controls">
            <div>
              <h1>{(config.clusters && activeCluster) ? config.clusters[activeCluster] : '所有岗位'}</h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {(!activeTier || activeTier === 'all' || !ACTIVITY_TIERS[activeTier]) ? '全部活跃度' : ACTIVITY_TIERS[activeTier].title} · 当前显示 {filteredJobs.length} 项
              </p>
            </div>

            <div className="filters-section" style={{
              marginTop: '16px',
              padding: '12px 24px',
              background: 'rgba(255, 255, 255, 0.02)',
              borderRadius: '16px',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              alignItems: 'center',
              gap: '32px',
              flexWrap: 'wrap'
            }}>
              {/* Score Slider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="filter-group-label" style={{ margin: 0, fontSize: '0.7rem', textTransform: 'none', letterSpacing: 'normal' }}>模型评分</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  className="custom-slider"
                  value={scoreThreshold}
                  onChange={(e) => setScoreThreshold(parseInt(e.target.value))}
                  style={{
                    width: '100px',
                    margin: 0,
                    background: `linear-gradient(to right, var(--accent) ${scoreThreshold}%, rgba(255, 255, 255, 0.1) ${scoreThreshold}%)`
                  }}
                />
                <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--accent)', minWidth: '32px' }}>{scoreThreshold}+</span>
              </div>

              <div style={{ width: '1px', height: '16px', background: 'var(--border)', opacity: 0.2 }}></div>

              {/* Status Tabs */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="filter-group-label" style={{ margin: 0, fontSize: '0.7rem' }}>人工评分</span>
                <div className="filter-tabs" style={{ marginTop: 0, gap: '16px' }}>
                  {['all', 'unrated', 'rated'].map(f => (
                    <div
                      key={f}
                      className={`filter-tab ${statusFilter === f ? 'active' : ''}`}
                      onClick={() => setStatusFilter(f)}
                      style={{ fontSize: '0.8rem', padding: '4px 0' }}
                    >
                      {f === 'all' ? '全部' : f === 'unrated' ? '未处理' : '已评分'}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ width: '1px', height: '16px', background: 'var(--border)', opacity: 0.2 }}></div>

              {/* View Tabs */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
                <div className="filter-tabs" style={{ marginTop: 0, gap: '16px' }}>
                  <div className={`filter-tab ${!expandAll ? 'active' : ''}`} onClick={() => setExpandAll(false)} style={{ fontSize: '0.8rem', padding: '4px 0' }}>收起</div>
                  <div className={`filter-tab ${expandAll ? 'active' : ''}`} onClick={() => setExpandAll(true)} style={{ fontSize: '0.8rem', padding: '4px 0' }}>展开</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {loading ? <p>数据加载中...</p> : (
          <div className="job-list-container" style={{ position: 'relative', overflow: 'hidden' }}>
            <div
              className="job-list"
              ref={jobListRef}
            >
              {filteredJobs.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', marginTop: '40px', textAlign: 'center' }}>
                  暂无匹配结果。
                </div>
              ) : (
                filteredJobs.map(job => (
                  <JobItem
                    key={job.id}
                    job={job}
                    expandAll={expandAll}
                    onUpdate={handleLocalUpdate}
                  />
                ))
              )}
            </div>

            {/* Removed redundant overscroll hint to favor native UI feel */}
          </div>
        )}
      </div>
    </>
  );
}

const HeartIcon = ({ filled, hovered }) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="currentColor"
    style={{ display: 'block' }}
  >
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.53L12 21.35z" />
  </svg>
);

function HeartRating({ value, onChange, onLongPress }) {
  const [hoverIndex, setHoverIndex] = useState(0);
  const hearts = [1, 2, 3, 4, 5];
  const timerRef = useRef(null);

  const startPress = (s) => {
    timerRef.current = setTimeout(() => {
      if (onLongPress) onLongPress(s);
      timerRef.current = null; // Mark as long-pressed
    }, 600);
  };

  const endPress = (s) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      // Short click
      if (value === s) onChange(null);
      else onChange(s);
    }
  };

  return (
    <div className="heart-rating" onMouseLeave={() => setHoverIndex(0)}>
      {hearts.map(s => (
        <span
          key={s}
          className={`heart ${s <= (hoverIndex || (value || 0)) ? 'filled' : ''} ${s <= hoverIndex ? 'hovered' : ''}`}
          onMouseEnter={() => setHoverIndex(s)}
          onMouseDown={() => startPress(s)}
          onMouseUp={() => endPress(s)}
          onTouchStart={() => startPress(s)}
          onTouchEnd={(e) => {
            if (timerRef.current) {
              endPress(s);
              e.preventDefault();
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <HeartIcon
            filled={s <= (hoverIndex || (value || 0))}
            hovered={s <= hoverIndex}
          />
        </span>
      ))}
    </div>
  );
}

function JobItem({ job, onUpdate, expandAll }) {
  const [userScore, setUserScore] = useState(job.user_score ? job.user_score / 20 : null);
  const [notes, setNotes] = useState(job.user_notes || '');
  const [showJD, setShowJD] = useState(expandAll);
  const [showNotes, setShowNotes] = useState(!!job.user_notes);
  const debounceRef = useRef(null);
  const noteInputRef = useRef(null);

  // Sync with global expand/collapse
  useEffect(() => {
    setShowJD(expandAll);
  }, [expandAll]);

  // Synchronize internal state with job prop
  useEffect(() => {
    setUserScore(job.user_score ? job.user_score / 20 : null);
    setNotes(job.user_notes || '');
  }, [job.user_score, job.user_notes]);

  const saveFeedback = useCallback(async (newScore, newNotes) => {
    // Convert 1-5 to 20-100 logic, but map null to null
    const numericScore = newScore === null ? null : Math.round(newScore * 20);

    try {
      // Optimistically update parent state
      onUpdate(job.id, numericScore, newNotes);

      await fetch(`${API_BASE_URL}/api/jobs/${job.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_score: numericScore,
          user_notes: newNotes
        })
      });
    } catch (error) {
      console.error('Error saving feedback:', error);
    }
  }, [job.id, onUpdate]);

  const handleStarChange = (newStar) => {
    setUserScore(newStar);
    saveFeedback(newStar, notes);
  };

  const handleLongPress = (newStar) => {
    setUserScore(newStar);
    setShowNotes(true);
    saveFeedback(newStar, notes);
    setTimeout(() => {
      if (noteInputRef.current) noteInputRef.current.focus();
    }, 100);
  };

  const handleContacted = () => {
    const tag = "【已联系】";
    if (notes.startsWith(tag)) return;
    const newNotes = tag + notes;
    setNotes(newNotes);
    setShowNotes(true);
    saveFeedback(userScore, newNotes);
  };

  const handleNoteChange = (e) => {
    const val = e.target.value;
    setNotes(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveFeedback(userScore, val);
    }, 800);
  };

  const parseMetrics = (rationale) => {
    const match = /\[hard_indicators:(\d+)\|domain_relevance:(\d+)\|technical_skills:(\d+)\|project_scenario:(\d+)\]/.exec(rationale);
    if (!match) return null;
    return {
      hard: match[1],
      domain: match[2],
      tech: match[3],
      project: match[4]
    };
  };

  const splitRationale = (rationale) => {
    if (!rationale) return { conclusion: "尚未分析", details: "" };

    // Remove metrics block [hard_indicators:...] if present
    let text = rationale.replace(/\[.*?\]/g, '').trim();

    // GLM5 might just return a direct reason without "思考:" or "总结:" prefixes
    // If it contains "领域契合:", treat it as the conclusion
    if (text.includes('领域契合:')) {
      const parts = text.split(';');
      return {
        conclusion: parts[0].trim(),
        details: parts.slice(1).join('; ').trim()
      };
    }

    // Normalize punctuation
    text = text.replace(/：/g, ':').replace(/，/g, ',');

    let conclusion = "";
    let details = "";

    // Standard Tags to look for
    const concludeTags = ['总结:', '结论:', '建议:'];
    const detailTags = ['思考链路:', '理由:', '分析:'];

    // Try to find summary/conclusion first
    let foundConcludeIdx = -1;
    let foundConcludeTag = "";
    for (const tag of concludeTags) {
      const idx = text.indexOf(tag);
      if (idx !== -1 && (foundConcludeIdx === -1 || idx < foundConcludeIdx)) {
        foundConcludeIdx = idx;
        foundConcludeTag = tag;
      }
    }

    // Try to find details/analysis
    let foundDetailIdx = -1;
    let foundDetailTag = "";
    for (const tag of detailTags) {
      const idx = text.indexOf(tag);
      if (idx !== -1 && (foundDetailIdx === -1 || idx < foundDetailIdx)) {
        foundDetailIdx = idx;
        foundDetailTag = tag;
      }
    }

    if (foundConcludeIdx !== -1 && foundDetailIdx !== -1) {
      if (foundConcludeIdx > foundDetailIdx) {
        // "Analysis... Conclusion..."
        details = text.substring(foundDetailIdx + foundDetailTag.length, foundConcludeIdx).trim();
        conclusion = text.substring(foundConcludeIdx + foundConcludeTag.length).trim();
      } else {
        // "Conclusion... Analysis..."
        conclusion = text.substring(foundConcludeIdx + foundConcludeTag.length, foundDetailIdx).trim();
        details = text.substring(foundDetailIdx + foundDetailTag.length).trim();
      }
    } else if (foundConcludeIdx !== -1) {
      conclusion = text.substring(foundConcludeIdx + foundConcludeTag.length).trim();
      details = text.substring(0, foundConcludeIdx).replace(/^打分\s*:\s*\d+/, '').trim();
    } else if (foundDetailIdx !== -1) {
      details = text.substring(foundDetailIdx + foundDetailTag.length).trim();
      conclusion = text.substring(0, foundDetailIdx).replace(/^打分\s*:\s*\d+/, '').trim();
    } else {
      conclusion = text.replace(/^打分\s*:\s*\d+/, '').trim();
      details = "";
    }

    return {
      conclusion: conclusion || "评估结论",
      details: details
    };
  };

  const normalizePunctuation = (text) => {
    if (!text) return "";
    return text
      .replace(/,/g, '，')
      .replace(/\./g, '。')
      .replace(/:/g, '：')
      .replace(/;/g, '；')
      .replace(/\?/g, '？')
      .replace(/!/g, '！')
      .replace(/\(/g, '（')
      .replace(/\)/g, '）');
  };

  const metrics = parseMetrics(job.rationale);
  const rawAnalysis = splitRationale(job.rationale);

  const analysis = {
    conclusion: normalizePunctuation(rawAnalysis.conclusion),
    details: normalizePunctuation(rawAnalysis.details)
  };

  const getCircles = (val, max) => {
    const norm = Math.round((val / max) * 5);
    return '●'.repeat(norm) + '○'.repeat(5 - norm);
  };

  return (
    <div className="job-card">
      <div className="card-scroll-area">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <a href={job.link} target="_blank" rel="noopener noreferrer" className="job-title">
              {job.title} - {job.company}
            </a>
            <div className="job-meta">
              <span className="meta-item"><Icons.Location /> {job.location || '远程/待定'}</span>
              <span className="meta-item"><Icons.Salary /> {job.salary}</span>
              <span className="meta-item"><Icons.Time /> {job.update_time || '未知时间'}</span>
            </div>
          </div>
        </div>

        {metrics && (
          <div className="score-line">
            指标: 硬标 {getCircles(metrics.hard, 20)} | 领域 {getCircles(metrics.domain, 40)} | 技术 {getCircles(metrics.tech, 20)} | 项目 {getCircles(metrics.project, 20)}
          </div>
        )}

        <div className="callout-header" style={{ marginBottom: '8px', fontSize: '0.85rem', color: '#fff', fontWeight: 700 }}>
          GLM-5 评分：{job.score} 分
        </div>
        <div className="callout">
          <div className="callout-body">
            <div><strong>结论</strong>：{analysis.conclusion}</div>
            <div style={{ height: '14px' }}></div>
            {analysis.details && <div><strong>分析</strong>：{analysis.details}</div>}
          </div>
        </div>

        <div className="jd-collapsible">
          <div className="jd-summary" onClick={() => setShowJD(!showJD)}>
            {showJD ? <Icons.ChevronDown /> : <Icons.ChevronRight />} 原始岗位描述
          </div>
          {showJD && <div className="jd-content">{job.jd}</div>}
        </div>
      </div>

      <div className="feedback-actions" style={{ alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="rating-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>人工评分</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <HeartRating value={userScore} onChange={handleStarChange} onLongPress={handleLongPress} />
            <div style={{ width: '1px', height: '18px', background: 'var(--border)', opacity: 0.6, margin: '0 4px' }}></div>
            <div
              className={`contacted-btn ${notes.startsWith('【已联系】') ? 'active' : ''}`}
              onClick={handleContacted}
              title="标记为已联系"
              style={{
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
                color: notes.startsWith('【已联系】') ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
                fontSize: '1.8rem',
                lineHeight: 1
              }}
            >
              <Icons.Mail />
            </div>
          </div>
        </div>
        {(showNotes || window.innerWidth > 768) && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="text"
              className="user-note-input"
              value={notes}
              onChange={handleNoteChange}
              ref={noteInputRef}
              placeholder="备注内容..."
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
