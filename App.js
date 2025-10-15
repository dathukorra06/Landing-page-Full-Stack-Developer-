import React, { useEffect, useRef, useState } from 'react';

const API = process.env.REACT_APP_API || 'http://localhost:5000';

function VideoPlayer({ hlsUrl }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const attach = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
      } else {
        if (!window.Hls) {
          try {
            const mod = await import('hls.js');
            window.Hls = mod.default || mod;
          } catch (e) {
            console.error('Failed to load hls.js', e);
            return;
          }
        }
        const hls = new window.Hls();
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
      }
    };
    attach();
  }, [hlsUrl]);

  return (
    <div style={{ position: 'relative', width: 800 }}>
      <video ref={videoRef} controls style={{ width: '100%', height: 'auto' }} />
    </div>
  );
}

function joinUrl(base, path) {
  // Use the URL constructor when available to safely join base and path
  try {
    return new URL(path, base).toString();
  } catch (e) {
    // fallback: simple join
    return (base.replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
  }
}

export default function App() {
  const [overlays, setOverlays] = useState([]); // overlays stored with percent coordinates { x, y, width, height } in percent (0-100)
  const [hlsUrl, setHlsUrl] = useState('http://localhost:5000/hls/stream.m3u8');
  const [rtspUrl, setRtspUrl] = useState('rtsp://rtsp.me/sample');
  // second stream support
  const [hlsUrl2, setHlsUrl2] = useState('http://localhost:5000/hls/stream2.m3u8');
  const [rtspUrl2, setRtspUrl2] = useState('rtsp://rtsp.me/sample');
  const [form, setForm] = useState({ x: 1.25, y: 2.22, width: 18.75, height: 8.89, content: 'Overlay text', type: 'text' });
  const [fileInput, setFileInput] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStreaming2, setIsStreaming2] = useState(false);
  const [backendHealth, setBackendHealth] = useState({ ffmpeg: false, mongo: 'unknown' });
  const [statusMessage, setStatusMessage] = useState('');
  const videoRef = useRef(null);
  const videoRef2 = useRef(null);
  const videoContainerRef = useRef(null);
  const containerRef = useRef(null);
  const dragInfo = useRef({ active: false });
  const [containerSize, setContainerSize] = useState({ width: 800, height: 450 });

  useEffect(() => {
    const fetchOverlays = async () => {
      try {
        const r = await fetch(`${API}/api/overlays`);
        const data = await r.json();
        if (!Array.isArray(data)) return setOverlays([]);
        // convert to percent coordinates if needed
        const rect = videoContainerRef.current && videoContainerRef.current.getBoundingClientRect();
        const w = rect ? rect.width : containerSize.width;
        const h = rect ? rect.height : containerSize.height;
        const conv = data.map(o => {
          // if overlay already marked as percent, use directly
          if (o.coord_unit === 'percent') return o;
          // heuristic: if any value > 100 treat as pixels and convert
          const seemsPixels = (o.x > 100 || o.y > 100 || o.width > 100 || o.height > 100);
          if (seemsPixels) {
            return { ...o,
              x: (o.x / w) * 100,
              y: (o.y / h) * 100,
              width: (o.width / w) * 100,
              height: (o.height / h) * 100,
              coord_unit: 'percent'
            };
          }
          // otherwise assume the numbers are already percent (or small pixels) - treat as percent
          return { ...o, coord_unit: 'percent' };
        });
        setOverlays(conv.map(o => ({ ...o })));
      } catch (e) {
        setOverlays([]);
      }
    };
    fetchOverlays();
  }, []);

  // track container size for conversions
  useEffect(() => {
    const updateSize = () => {
      const rect = videoContainerRef.current && videoContainerRef.current.getBoundingClientRect();
      if (rect) setContainerSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const createOverlay = async () => {
    // form fields are percent values
    let payload = { ...form, coord_unit: 'percent' };
    // if image file selected and type is image, upload first
    if (form.type === 'image' && fileInput) {
      try {
        const fd = new FormData();
        fd.append('file', fileInput);
        const up = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
        if (up.status === 201) {
          const ud = await up.json();
          payload.content = ud.url; // store the uploaded URL in content
        } else {
          console.error('Upload failed', await up.text());
        }
      } catch (e) {
        console.error('Upload exception', e);
      }
    }

    const res = await fetch(`${API}/api/overlays`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    const doc = await res.json();
    if (doc && doc._id) {
      // ensure stored with percent
      setOverlays(prev=>[...prev, { ...doc, coord_unit: 'percent' }]);
    } else {
      console.error('Create overlay failed', doc);
      // keep overlays unchanged
    }
  };

  const updateOverlay = async (id, patch) => {
    // ensure backend knows coords are percent
    const body = { ...patch, coord_unit: 'percent' };
    const res = await fetch(`${API}/api/overlays/${id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const doc = await res.json();
    if (doc && doc._id) {
      setOverlays(prev=>prev.map(o => o._id === id ? { ...doc, coord_unit: 'percent' } : o));
    } else {
      console.error('Update overlay failed', doc);
    }
  };

  const deleteOverlay = async (id) => {
    await fetch(`${API}/api/overlays/${id}`, { method: 'DELETE' });
    setOverlays(prev=>prev.filter(o=>o._id !== id));
  };

  // Drag / resize handlers
  useEffect(() => {
    const onMove = (e) => {
      if (!dragInfo.current.active) return;
      const rect = containerRef.current && containerRef.current.getBoundingClientRect();
      const cW = rect ? rect.width : containerSize.width;
      const cH = rect ? rect.height : containerSize.height;
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      setOverlays(prev => prev.map(o => {
        if (o._id !== dragInfo.current.id) return o;
        if (dragInfo.current.mode === 'drag') {
          const nxPx = Math.max(0, mx - dragInfo.current.offsetX);
          const nyPx = Math.max(0, my - dragInfo.current.offsetY);
          const nx = Math.round((nxPx / cW) * 100 * 100) / 100; // two decimals
          const ny = Math.round((nyPx / cH) * 100 * 100) / 100;
          return { ...o, x: nx, y: ny };
        } else if (dragInfo.current.mode === 'resize') {
          // compute current left in px
          const leftPx = (o.x / 100) * cW;
          const topPx = (o.y / 100) * cH;
          const nwPx = Math.max(10, Math.round(mx - leftPx));
          const nhPx = Math.max(10, Math.round(my - topPx));
          const nw = Math.round((nwPx / cW) * 100 * 100) / 100;
          const nh = Math.round((nhPx / cH) * 100 * 100) / 100;
          return { ...o, width: nw, height: nh };
        }
        return o;
      }));
    };

    const onUp = (e) => {
      if (!dragInfo.current.active) return;
      const id = dragInfo.current.id;
      const o = overlays.find(x => x._id === id);
      if (o) {
        updateOverlay(id, o).catch(()=>{});
      }
      dragInfo.current = { active: false };
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [overlays]);

  const startStream = async () => {
    const res = await fetch(`${API}/api/start_stream`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rtsp_url: rtspUrl, target: 'stream' })
    });
    const doc = await res.json();
    if (doc.hls_url) {
      setHlsUrl(joinUrl(API, doc.hls_url));
      setIsStreaming(true);
      setStatusMessage('Stream 1 started');
    } else if (doc.status === 'already_running') {
      setStatusMessage('A stream is already running on the server. Stop it first or use a backend that supports multiple simultaneous streams.');
    } else {
      setStatusMessage(JSON.stringify(doc));
    }
  };

  const stopStream = async () => {
    await fetch(`${API}/api/stop_stream`, { method: 'POST' });
    setIsStreaming(false);
  };

  // start/stop for second stream (target: stream2)
  const startStream2 = async () => {
    const res = await fetch(`${API}/api/start_stream`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rtsp_url: rtspUrl2, target: 'stream2' })
    });
    const doc = await res.json();
    if (doc.hls_url) {
      setHlsUrl2(joinUrl(API, doc.hls_url));
      setIsStreaming2(true);
      setStatusMessage('Stream 2 started');
    } else if (doc.status === 'already_running') {
      setStatusMessage('A stream is already running on the server. Stop it first or use a backend that supports multiple simultaneous streams.');
    } else {
      setStatusMessage(JSON.stringify(doc));
    }
  };

  const stopStream2 = async () => {
    // backend stop_stream stops the currently running ffmpeg process; when multiple
    // streams are started separately the backend would need to support per-target
    // management. Current backend stops global ffmpeg, so we still call stop
    await fetch(`${API}/api/stop_stream`, { method: 'POST' });
    setIsStreaming2(false);
  };

  // Poll health periodically to reflect server state and whether ffmpeg is available
  useEffect(() => {
    let mounted = true;
    const fetchHealth = async () => {
      try {
        const r = await fetch(`${API}/api/health`);
        const j = await r.json();
        if (!mounted) return;
        setBackendHealth(j);
        // if backend indicates ffmpeg exists but we are not streaming, don't assume streaming
        // however, if ffmpeg is false (not on path), show a message
        if (!j.ffmpeg) setStatusMessage('ffmpeg not found on backend PATH — streaming will fail');
      } catch (e) {
        if (!mounted) return;
        setBackendHealth({ ffmpeg: false, mongo: 'unreachable' });
      }
    };
    fetchHealth();
    const iv = setInterval(fetchHealth, 5000);
    return () => { mounted = false; clearInterval(iv); };
  }, []);

  // attach hls to the inline video element when hlsUrl changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const attach = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
      } else {
        if (!window.Hls) {
          try {
            const mod = await import('hls.js');
            window.Hls = mod.default || mod;
          } catch (e) {
            console.error('Failed to load hls.js', e);
            return;
          }
        }
        const hls = new window.Hls();
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
      }
    };
    attach();
  }, [hlsUrl]);

  // attach hls to second video when hlsUrl2 changes
  useEffect(() => {
    const video = videoRef2.current;
    if (!video) return;
    const attach = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl2;
      } else {
        if (!window.Hls) {
          try {
            const mod = await import('hls.js');
            window.Hls = mod.default || mod;
          } catch (e) {
            console.error('Failed to load hls.js', e);
            return;
          }
        }
        const hls = new window.Hls();
        hls.loadSource(hlsUrl2);
        hls.attachMedia(video);
      }
    };
    attach();
  }, [hlsUrl2]);

  return (
    <div>
      <h2>RTSP Overlay Demo</h2>
  <div style={{display:'flex', gap:20}}>
        <div>
          <p>RTSP URL (stream 1):</p>
          <input value={rtspUrl} onChange={e=>setRtspUrl(e.target.value)} style={{width:600}} />
          <div style={{marginTop:6}}>
            <button onClick={startStream} disabled={isStreaming || backendHealth.ffmpeg && statusMessage && statusMessage.includes('already running')}>Start Stream 1</button>
            <button onClick={stopStream} disabled={!isStreaming} style={{marginLeft:6}}>Stop Stream 1</button>
          </div>
          <p>HLS URL (player 1):</p>
          <input value={hlsUrl} onChange={e=>setHlsUrl(e.target.value)} style={{width:600}} />
        </div>

        <div>
          <p>RTSP URL (stream 2):</p>
          <input value={rtspUrl2} onChange={e=>setRtspUrl2(e.target.value)} style={{width:600}} />
          <div style={{marginTop:6}}>
            <button onClick={startStream2} disabled={isStreaming2 || backendHealth.ffmpeg && statusMessage && statusMessage.includes('already running')}>Start Stream 2</button>
            <button onClick={stopStream2} disabled={!isStreaming2} style={{marginLeft:6}}>Stop Stream 2</button>
          </div>
          <p>HLS URL (player 2):</p>
          <input value={hlsUrl2} onChange={e=>setHlsUrl2(e.target.value)} style={{width:600}} />
        </div>
      </div>
      <div style={{marginTop:12}}>
        <strong>Backend health:</strong> ffmpeg: {String(backendHealth.ffmpeg)} , mongo: {String(backendHealth.mongo)}
      </div>
      {statusMessage ? <div style={{marginTop:6, color:'darkred'}}>{statusMessage}</div> : null}
      <div style={{display:'flex', gap:20, marginTop:10}}>
        <div>
          <div style={{ position: 'relative', width: 800 }}>
            <video ref={videoRef} controls style={{ width: '100%', height: 'auto' }} />
          </div>
          <div style={{ height: 12 }} />
          <div style={{ position: 'relative', width: 800 }}>
            <video ref={videoRef2} controls style={{ width: '100%', height: 'auto' }} />
          </div>
        </div>
        <div style={{width:300}}>
          <h3>New overlay</h3>
          <label>X%: <input type='number' step='0.01' value={form.x} onChange={e=>setForm({...form, x: parseFloat(e.target.value||0)})} /></label><br/>
          <label>Y%: <input type='number' step='0.01' value={form.y} onChange={e=>setForm({...form, y: parseFloat(e.target.value||0)})} /></label><br/>
          <label>W%: <input type='number' step='0.01' value={form.width} onChange={e=>setForm({...form, width: parseFloat(e.target.value||0)})} /></label><br/>
          <label>H%: <input type='number' step='0.01' value={form.height} onChange={e=>setForm({...form, height: parseFloat(e.target.value||0)})} /></label><br/>
          <label>Text: <input value={form.content} onChange={e=>setForm({...form, content: e.target.value})} style={{width:'100%'}}/></label><br/>
          <label>Type: <select value={form.type} onChange={e=>setForm({...form, type: e.target.value})}>
            <option value='text'>Text</option>
            <option value='image'>Image</option>
          </select></label><br/>
          {form.type === 'image' && (
            <div>
              <label>Image file: <input type='file' accept='image/*' onChange={e=>setFileInput(e.target.files[0]||null)} /></label>
            </div>
          )}
          <button onClick={createOverlay}>Add</button>

          <h3>Saved overlays</h3>
          {Array.isArray(overlays) ? overlays.map(o=>(
            <div key={o._id} style={{border:'1px solid #ccc', marginBottom:8, padding:6}}>
              <div><strong>{o.content}</strong></div>
              <div>pos: {o.x}% , {o.y}% size: {o.width}% x {o.height}%</div>
              <div style={{display:'flex', gap:6, marginTop:6}}>
                <button onClick={()=>updateOverlay(o._id, {...o, x: o.x+10})}>Move right</button>
                <button onClick={()=>deleteOverlay(o._id)}>Delete</button>
              </div>
            </div>
          )) : <div style={{color:'red'}}>Overlays unavailable (check backend)</div>}
        </div>
      </div>

      {/* Overlay rendering */}
  <div ref={containerRef} style={{position:'relative', width:800, pointerEvents:'none', marginTop:12}}>
        <div style={{position:'absolute', left:0, top:0, width:'100%', height:'0'}}></div>
        {overlays.map(o=>(
          <div key={o._id}
                onMouseDown={(e)=>{
                 // start dragging
                 e.stopPropagation();
                 const rect = containerRef.current && containerRef.current.getBoundingClientRect();
                 const mx = e.clientX - (rect ? rect.left : 0);
                 const my = e.clientY - (rect ? rect.top : 0);
                 // compute pixel position of overlay left/top
                 const leftPx = (o.x / 100) * (rect ? rect.width : containerSize.width);
                 const topPx = (o.y / 100) * (rect ? rect.height : containerSize.height);
                 dragInfo.current = { active: true, id: o._id, mode: 'drag', offsetX: mx - leftPx, offsetY: my - topPx };
               }}
               style={{
                 position:'absolute',
                 left: (o.x/100) * (containerSize.width) ,
                 top: (o.y/100) * (containerSize.height),
                 width: (o.width/100) * (containerSize.width),
                 height: (o.height/100) * (containerSize.height),
                 background: 'rgba(0,0,0,0.4)',
                 color: '#fff',
                 display: 'flex',
                 alignItems: 'center',
                 justifyContent: 'center',
                 pointerEvents: 'auto',
                 cursor: 'move',
                 userSelect: 'none'
               }}>
            {o.type === 'image' ? (
              <img src={o.content} alt="overlay" style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
            ) : (
              o.content
            )}
            {/* resize handle */}
            <div
              onMouseDown={(e)=>{
                e.stopPropagation();
                dragInfo.current = { active: true, id: o._id, mode: 'resize' };
              }}
              style={{ position: 'absolute', right: 2, bottom: 2, width:12, height:12, background:'#fff', cursor:'nwse-resize', zIndex: 10 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
