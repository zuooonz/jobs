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
  )
};

// API Configuration
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || `http://${window.location.hostname}:8888`;

function App() {
  const [jobs, setJobs] = useState([]);
  const [config, setConfig] = useState({ clusters: {}, categorization_rules: [] });
  const [isDemo, setIsDemo] = useState(false);
  const [activeCluster, setActiveCluster] = useState("");
  const [activeTier, setActiveTier] = useState("1_HIGHLY_ACTIVE");
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandAll, setExpandAll] = useState(window.innerWidth > 768);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [overscrollOffset, setOverscrollOffset] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);

  const contentRef = useRef(null);
  const jobListRef = useRef(null);
  const touchStartRef = useRef(null);

  const fetchJobs = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/jobs`);
      if (!response.ok) throw new Error('Network response not ok');
      const data = await response.json();
      setJobs(data);
      setIsDemo(false);
    } catch (error) {
      console.warn('Backend reach failed. Falling back to Demo Mode data.');
      setJobs(demoJobs);
      setIsDemo(true);
    }
  };

  const fetchConfig = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/config`);
      if (!response.ok) throw new Error('Network response not ok');
      const data = await response.json();
      setConfig(data);
      if (data.clusters && Object.keys(data.clusters).length > 0) {
        setActiveCluster(Object.keys(data.clusters)[0]);
      }
    } catch (error) {
      console.warn('Backend reaches failed. Falling back to Demo Mode config.');
      setConfig(demoConfig);
      if (demoConfig.clusters && Object.keys(demoConfig.clusters).length > 0) {
        setActiveCluster(Object.keys(demoConfig.clusters)[0]);
      }
    }
  };

  const initialize = async () => {
    setLoading(true);
    await Promise.all([fetchJobs(), fetchConfig()]);
    setLoading(false);
  };

  useEffect(() => {
    initialize();
  }, []);
  const handleTouchStart = (e) => {
    if (window.innerWidth > 768) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      scrollLeft: jobListRef.current ? jobListRef.current.scrollLeft : 0
    };
  };

  const handleTouchMove = (e) => {
    if (!touchStartRef.current || window.innerWidth > 768) return;

    const deltaX = e.touches[0].clientX - touchStartRef.current.x;
    const deltaY = e.touches[0].clientY - touchStartRef.current.y;

    // Favor vertical scroll if it's more vertical than horizontal
    if (Math.abs(deltaY) > Math.abs(deltaX) + 10) {
      setDragOffset(0);
      setOverscrollOffset(0);
      return;
    }

    const scrollLeft = touchStartRef.current.scrollLeft;
    const clientWidth = jobListRef.current.clientWidth;
    const scrollWidth = jobListRef.current.scrollWidth;
    const isAtStart = scrollLeft <= 5;
    const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 5;

    let nextDrag = 0;
    let nextOverscroll = 0;

    if (isAtStart && deltaX > 0) {
      // Swiping right at the start - Rubber band + Sidebar trigger
      nextDrag = deltaX * 0.4;
      if (deltaX > 100) {
        setIsSidebarOpen(true);
        touchStartRef.current = null;
        setDragOffset(0);
        setOverscrollOffset(0);
        return;
      }
    } else if (isAtEnd && deltaX < 0) {
      // Swiping left at the end - Rubber band + "No more" hint
      nextDrag = deltaX * 0.4;
      nextOverscroll = Math.abs(deltaX);
    }

    setDragOffset(nextDrag);
    setOverscrollOffset(nextOverscroll);
  };

  const handleTouchEnd = () => {
    touchStartRef.current = null;
    setOverscrollOffset(0);
    setDragOffset(0);
  };

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
    return processedJobs.filter(job => {
      const clusterMatch = job._cluster === activeCluster;
      const tierMatch = activeTier === 'all' || job._tier === activeTier;

      if (!(clusterMatch && tierMatch)) return false;

      if (statusFilter === 'rated') return job._isRated;
      if (statusFilter === 'unrated') return !job._isRated;
      return true;
    });
  }, [processedJobs, activeCluster, activeTier, statusFilter]);

  // Handle local feedback updates
  const handleLocalUpdate = useCallback((jobId, newScore, newNotes) => {
    setJobs(prevJobs => prevJobs.map(job =>
      job.id === jobId ? { ...job, user_score: newScore, user_notes: newNotes } : job
    ));
  }, []);

  // Effects (defined after dependencies)
  useEffect(() => {
    fetchJobs();
  }, []);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo(0, 0);
    }
    if (jobListRef.current) {
      jobListRef.current.scrollTo(0, 0); // Reset horizontal scroll for mobile
    }
  }, [activeCluster, activeTier, statusFilter]);

  useEffect(() => {
    if (!loading && processedJobs.length > 0) {
      // Check if current cluster + tier selection has data
      const currentCount = processedJobs.filter(j => {
        const clusterMatch = j._cluster === activeCluster;
        const tierMatch = activeTier === 'all' || j._tier === activeTier;
        return clusterMatch && tierMatch;
      }).length;

      // Only auto-switch if the current view is empty
      if (currentCount === 0) {
        for (const clusterId of Object.keys(config.clusters || {})) {
          for (const tierId of Object.keys(ACTIVITY_TIERS)) {
            const hasData = processedJobs.some(j => j._cluster === clusterId && j._tier === tierId);
            if (hasData) {
              setActiveCluster(clusterId);
              setActiveTier(tierId);
              return;
            }
          }
        }
      }
    }
  }, [loading, processedJobs, activeCluster, activeTier]);

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
                    setActiveCluster(clusterId);
                    setActiveTier('all');
                    setStatusFilter('all');
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
                        setActiveCluster(clusterId);
                        setActiveTier(tierId);
                        setStatusFilter('all');
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

            <div className="filter-group" style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>数据筛选</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['all', 'unrated', 'rated'].map(f => (
                    <button
                      key={f}
                      className={`filter-btn-mobile ${statusFilter === f ? 'active' : ''}`}
                      onClick={() => setStatusFilter(f)}
                    >
                      {f === 'all' ? '全部' : f === 'unrated' ? '未评分' : '已评分'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>内容折叠</span>
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
        <div className="header">
          <div className="mobile-header">
            <button className="menu-toggle" onClick={() => setIsSidebarOpen(true)}>
              <Icons.Menu />
            </button>
            <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>职位数据看板</span>
          </div>
          <div className="header-controls">
            <div>
              <h1>{config.clusters ? config.clusters[activeCluster] : '加载中...'}</h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {activeTier === 'all' ? '全部活跃度' : ACTIVITY_TIERS[activeTier].title} · 当前显示 {filteredJobs.length} 项
              </p>
            </div>
            <div className="filter-tabs">
              {['all', 'unrated', 'rated'].map(f => (
                <div
                  key={f}
                  className={`filter-tab ${statusFilter === f ? 'active' : ''}`}
                  onClick={() => setStatusFilter(f)}
                >
                  {f === 'all' ? '全部' : f === 'unrated' ? '未评分' : '已评分'}
                </div>
              ))}
              <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 8px' }} />
              <div
                className="filter-tab"
                onClick={() => setExpandAll(false)}
                style={{ color: !expandAll ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: !expandAll ? 700 : 500 }}
              >
                全部收起
              </div>
              <div
                className="filter-tab"
                onClick={() => setExpandAll(true)}
                style={{ color: expandAll ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: expandAll ? 700 : 500 }}
              >
                全部展开
              </div>
            </div>
          </div>
        </div>

        {loading ? <p>数据加载中...</p> : (
          <div className="job-list-container" style={{ position: 'relative', overflow: 'hidden' }}>
            <div
              className="job-list"
              ref={jobListRef}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              style={{
                transform: `translate3d(${dragOffset}px, 0, 0)`,
                transition: dragOffset === 0 ? 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)' : 'none'
              }}
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

            {/* Overscroll Hint - outside the translated list */}
            <div
              className="overscroll-hint"
              style={{
                right: overscrollOffset > 0 ? `${Math.min(20, overscrollOffset / 4)}px` : '-100px',
                opacity: overscrollOffset > 0 ? Math.min(1, overscrollOffset / 100) : 0,
                transform: `translateY(-50%) translateX(${overscrollOffset > 40 ? 0 : 20}px)`,
                top: '50%',
                position: 'absolute'
              }}
            >
              <div className="hint-pill">
                <span>没有更多啦</span>
              </div>
            </div>
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

    // Remove metrics block [hard_indicators:...]
    let text = rationale.replace(/\[.*?\]/g, '').trim();

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
            指标: 硬标 {getCircles(metrics.hard, 20)} | 领域 {getCircles(metrics.domain, 30)} | 技术 {getCircles(metrics.tech, 30)} | 项目 {getCircles(metrics.project, 20)}
          </div>
        )}

        <div className="callout-header" style={{ marginBottom: '8px', fontSize: '0.85rem', color: '#fff', fontWeight: 700 }}>
          Qwen 8B 评分：{job.score} 分
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

      <div className="feedback-actions">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span className="rating-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>星级评分</span>
          <HeartRating value={userScore} onChange={handleStarChange} onLongPress={handleLongPress} />
        </div>
        {(showNotes || window.innerWidth > 768) && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', justifyContent: 'flex-end' }}>
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
