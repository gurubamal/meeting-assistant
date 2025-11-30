import React, { useEffect, useRef, useState } from 'react'

// Basic text cleanup to reduce obvious repetition/noise from ASR
function cleanText(input) {
  if (!input) return ''
  let t = String(input)
  t = t.replace(/\s+/g, ' ').trim()
  // collapse repeated words (e.g., "how how how" -> "how")
  t = t.replace(/\b(\w[\w'-]*)\b(?:\s+\1\b){1,}/gi, '$1')
  // light de-dup of short repeated phrases (2–3 words repeated)
  const dedupPhrase = (s, n) => s.replace(new RegExp(`\\b((?:\\w[\\w'-]*\\s+){${n-1}}\\w[\\w'-]*)\\b(?:\\s+\\1\\b){1,}`, 'gi'), '$1')
  t = dedupPhrase(t, 2)
  t = dedupPhrase(t, 3)
  return t
}

const useSpeech = () => {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimText, setInterimText] = useState('')
  const [autoRestart, setAutoRestart] = useState(true)
  const [micStatus, setMicStatus] = useState('idle')
  const recognitionRef = useRef(null)
  const shouldRunRef = useRef(false)
  const restartingRef = useRef(false)

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    setSupported(true)
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onstart = () => { setListening(true); setMicStatus('listening') }
    rec.onresult = (e) => {
      let finals = ''
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) {
          finals += (res[0]?.transcript || '') + ' '
        } else {
          interim += (res[0]?.transcript || '') + ' '
        }
      }
      if (finals.trim()) {
        const add = cleanText(finals)
        setTranscript((t) => cleanText(t + ' ' + add))
      }
      setInterimText(interim.trim())
    }
    rec.onerror = (e) => {
      const err = e?.error || 'unknown'
      setMicStatus(`error:${err}`)
      // Benign errors we can restart on
      const canRestart = autoRestart && shouldRunRef.current && (err === 'no-speech' || err === 'network' || err === 'audio-capture')
      if (canRestart) safeRestart()
    }
    rec.onend = () => {
      setListening(false)
      if (autoRestart && shouldRunRef.current) {
        safeRestart()
      } else {
        setMicStatus('stopped')
      }
    }
    recognitionRef.current = rec

    function safeRestart() {
      if (!recognitionRef.current || restartingRef.current) return
      restartingRef.current = true
      setMicStatus('restarting')
      setTimeout(() => {
        try { recognitionRef.current.start() } catch {}
        restartingRef.current = false
      }, 400)
    }

    return () => {
      try { rec.stop() } catch {}
    }
  }, [autoRestart])

  const start = () => {
    if (!recognitionRef.current) return
    shouldRunRef.current = true
    try { recognitionRef.current.start() } catch {}
    setListening(true)
    setMicStatus('starting')
  }
  const stop = () => {
    if (!recognitionRef.current) return
    shouldRunRef.current = false
    try { recognitionRef.current.stop() } catch {}
    setListening(false)
    setMicStatus('stopped')
    setInterimText('')
  }

  return { supported, listening, transcript, setTranscript, start, stop, autoRestart, setAutoRestart, micStatus, interimText }
}

const defaultTickPrompt = `Return only the latest summary with no carryover.\n- Fresh 20s Summary — max 2 bullets (from Fresh excerpt only)\n- Decisions — only explicit (from Context excerpt); if none, "None yet."\n- Action Items — Table: Owner | Task | Due if stated | Timestamp. If none explicit, add up to 2 (suggested) with blank owner.\n- 3 sharp next questions (<12 words) prioritized for decisions/delivery.\nNo preamble; bullets/tables only.`

export default function App() {
  const { supported, listening, transcript, setTranscript, start, stop, autoRestart, setAutoRestart, micStatus, interimText } = useSpeech()
  const [sessionId, setSessionId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [tickPrompt, setTickPrompt] = useState(localStorage.getItem('tickPrompt') || defaultTickPrompt)
  const [finalSummary, setFinalSummary] = useState('')
  const sendBufferRef = useRef('')
  const prevLenRef = useRef(0)
  const sseRef = useRef(null)
  const [lastSentAt, setLastSentAt] = useState(0)
  const [intervalMs, setIntervalMs] = useState(10000)
  const [ticking, setTicking] = useState(false)
  const [windows, setWindows] = useState([])
  const [selectedWindows, setSelectedWindows] = useState(new Set())
  const [winSizeMs, setWinSizeMs] = useState(20000)
  const [windowSummary, setWindowSummary] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tabStream, setTabStream] = useState(null)
  const [tabStatus, setTabStatus] = useState('idle')
  const mediaRecRef = useRef(null)
  const micRecRef = useRef(null)
  const [meterLevel, setMeterLevel] = useState(0)
  const [meterStatus, setMeterStatus] = useState('idle')
  const [meterLabel, setMeterLabel] = useState('')
  const meterRef = useRef({ ac: null, analyser: null, rafId: 0, stream: null })
  const [provider, setProvider] = useState('codex'); // Default to codex/openai
  const [selectedModel, setSelectedModel] = useState('gpt-4o-mini'); // Default model for codex
  const [audioDevices, setAudioDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [useServerAsr, setUseServerAsr] = useState(true)

  const handleProviderChange = (e) => {
    const newProvider = e.target.value;
    setProvider(newProvider);
    if (newProvider === 'codex') {
      setSelectedModel('gpt-4o-mini');
    } else if (newProvider === 'gemini') {
      setSelectedModel('gemini-pro'); // Default to gemini-pro as per user request
    }
  };

  const handleModelChange = (e) => {
    setSelectedModel(e.target.value);
  };

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const inputs = devs.filter(d => d.kind === 'audioinput')
        setAudioDevices(inputs)
        if (!selectedDeviceId && inputs.length > 0) {
          const def = inputs.find(d => d.deviceId === 'default')
          setSelectedDeviceId(def ? def.deviceId : inputs[0].deviceId)
        }
      } catch (e) { console.error(e) }
    }
    fetchDevices()
    navigator.mediaDevices.addEventListener('devicechange', fetchDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', fetchDevices)
  }, [selectedDeviceId])

  useEffect(() => {
    const int = setInterval(() => {
      if (!sessionId) return
      const text = sendBufferRef.current.trim()
      if (!text) return
      fetch(`/api/session/${sessionId}/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      }).then(() => setLastSentAt(Date.now())).catch(() => {})
      sendBufferRef.current = ''
    }, 1000)
    return () => clearInterval(int)
  }, [sessionId])

  useEffect(() => {
    // Append only the new part of transcript since last change
    const newPart = transcript.slice(prevLenRef.current)
    if (newPart) sendBufferRef.current += ' ' + newPart
    prevLenRef.current = transcript.length
  }, [transcript])

  const startSession = async () => {
    const r = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model: selectedModel })
    })
    const j = await r.json()
    setSessionId(j.sessionId)
  }

  const openSSE = async () => {
    if (!sessionId || connected) return
    const src = new EventSource(`/api/session/${sessionId}/stream`)
    sseRef.current = src
    src.addEventListener('ready', (ev) => {
      try { const d = JSON.parse(ev.data); if (d.intervalMs) setIntervalMs(d.intervalMs) } catch {}
      setConnected(true)
    })
    src.addEventListener('suggestion', (ev) => {
      const data = JSON.parse(ev.data)
      setSuggestions((s) => [{ at: new Date(data.at).toLocaleTimeString(), text: data.text }, ...s])
    })
    src.onerror = () => {
      setConnected(false)
      src.close()
    }
  }

  const ensureConnected = async () => {
    // Create session if needed
    if (!sessionId) {
      const r = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: selectedModel })
      })
      const j = await r.json()
      setSessionId(j.sessionId)
      // apply prompt after session is created
      await fetch(`/api/session/${j.sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: tickPrompt })
      })
      localStorage.setItem('tickPrompt', tickPrompt)
      // open SSE
      const src = new EventSource(`/api/session/${j.sessionId}/stream`)
      sseRef.current = src
      src.addEventListener('ready', (ev) => {
        try { const d = JSON.parse(ev.data); if (d.intervalMs) setIntervalMs(d.intervalMs) } catch {}
        setConnected(true)
      })
      src.addEventListener('suggestion', (ev) => {
        const data = JSON.parse(ev.data)
        setSuggestions((s) => [{ at: new Date(data.at).toLocaleTimeString(), text: data.text }, ...s])
      })
      src.onerror = () => {
        setConnected(false)
        src.close()
      }
    } else if (!connected) {
      // session exists: apply prompt, then open SSE
      await fetch(`/api/session/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: tickPrompt })
      })
      localStorage.setItem('tickPrompt', tickPrompt)
      await openSSE()
    }
  }

  const finalize = async () => {
    if (!sessionId) return
    const r = await fetch(`/api/session/${sessionId}/finalize`)
    const j = await r.json().catch(() => ({}))
    setFinalSummary(j.summary || '')
  }

  const suggestNow = async () => {
    if (!sessionId) return
    setTicking(true)
    try {
      await fetch(`/api/session/${sessionId}/tick`, { method: 'POST' })
    } finally {
      setTicking(false)
    }
  }

  // Auto-connect when starting mic
  const startMic = async () => {
    await ensureConnected()
    if (useServerAsr) {
      await startServerMic()
    } else {
      start()
    }
    startInputMeter()
  }

  // Apply prompt on demand
  const applyPrompt = async () => {
    if (!sessionId) {
      await ensureConnected()
      return
    }
    await fetch(`/api/session/${sessionId}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: tickPrompt })
    })
    localStorage.setItem('tickPrompt', tickPrompt)
  }

  // Mic input meter (uses current site-selected mic, e.g., Stereo Mix)
  const startInputMeter = async () => {
    if (meterRef.current.ac) return
    try {
      const constraints = {
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      meterRef.current.stream = stream
      const track = stream.getAudioTracks()[0]
      setMeterLabel(track?.label || 'default input')

      // Refresh device list to ensure labels are populated (now that we have permission)
      navigator.mediaDevices.enumerateDevices().then(devs => {
        setAudioDevices(devs.filter(d => d.kind === 'audioinput'))
      }).catch(()=>{})

      const AC = window.AudioContext || window.webkitAudioContext
      const ac = new AC()
      const src = ac.createMediaStreamSource(stream)
      const analyser = ac.createAnalyser()
      analyser.fftSize = 2048
      src.connect(analyser)
      meterRef.current.ac = ac
      meterRef.current.analyser = analyser
      setMeterStatus('metering')
      const data = new Uint8Array(analyser.fftSize)
      const loop = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        setMeterLevel(rms)
        meterRef.current.rafId = requestAnimationFrame(loop)
      }
      loop()
    } catch (e) {
      console.error('startInputMeter failed', e)
      setMeterStatus('error')
    }
  }

  const stopInputMeter = () => {
    try { cancelAnimationFrame(meterRef.current.rafId) } catch {}
    try { meterRef.current.stream?.getTracks()?.forEach(t => t.stop()) } catch {}
    try { meterRef.current.ac?.close() } catch {}
    meterRef.current.ac = null
    meterRef.current.analyser = null
    meterRef.current.stream = null
    setMeterStatus('stopped')
    setMeterLevel(0)
  }

  // Tab/system audio capture
  function pickSupportedMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm; codecs=opus',
      'audio/webm',
    ]
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t
    }
    return '' // let browser choose
  }

  // Mic -> server ASR (whisper/transformers)
  const startServerMic = async () => {
    try {
      const constraints = {
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const mimeType = pickSupportedMime()
      const opts = mimeType ? { mimeType } : undefined
      const rec = new MediaRecorder(stream, opts)
      micRecRef.current = rec
      setMicStatus('capturing')
      setListening(true)
      rec.ondataavailable = (ev) => {
        const blob = ev.data
        if (!blob || !blob.size) return
        blob.arrayBuffer().then(buf => {
          if (!sessionId) return
          fetch(`/api/session/${sessionId}/audio`, {
            method: 'POST', headers: { 'Content-Type': mimeType || 'application/octet-stream' }, body: buf
          }).catch(()=>{})
        })
      }
      rec.onerror = (e) => { console.error('Mic MediaRecorder error', e); setMicStatus(`error:${e?.error || 'recorder'}`) }
      rec.onstop = () => { setMicStatus('stopped'); setListening(false) }
      rec.start(3000)
    } catch (e) {
      console.error('startServerMic failed', e)
      setMicStatus('error:mic-capture')
      alert('Failed to capture microphone. Check browser permissions and default device settings.')
    }
  }

  const stopServerMic = () => {
    try { micRecRef.current?.stop() } catch {}
    try { micRecRef.current?.stream?.getTracks()?.forEach(t => t.stop()) } catch {}
    micRecRef.current = null
    setListening(false)
  }

  const startTabAudio = async () => {
    try {
      await ensureConnected()
      setTabStatus('requesting')
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      // Extract audio track only to avoid codec/type mismatches
      const audioTracks = display.getAudioTracks()
      if (!audioTracks || audioTracks.length === 0) {
        setTabStatus('no-audio-track')
        throw new Error('no_audio_track: Choose Chrome tab and enable "Share tab audio" (or Entire screen + Share system audio).')
      }
      const stream = new MediaStream(audioTracks)
      setTabStream(stream)
      const mimeType = pickSupportedMime()
      const opts = mimeType ? { mimeType } : undefined
      const rec = new MediaRecorder(stream, opts)
      mediaRecRef.current = rec
      setTabStatus('capturing')
      rec.ondataavailable = (ev) => {
        const blob = ev.data
        if (!blob || !blob.size) return
        blob.arrayBuffer().then(buf => {
          if (!sessionId) return
          fetch(`/api/session/${sessionId}/audio`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType || 'application/octet-stream' },
            body: buf
          }).catch(()=>{})
        })
      }
      rec.onerror = (e) => { console.error('MediaRecorder error', e); setTabStatus(`error:${e?.error || 'recorder'}`) }
      rec.onstop = () => { setTabStatus('stopped') }
      rec.start(3000) // 3s chunks for stability
    } catch (e) {
      console.error('startTabAudio failed', e)
      const msg = e && e.message ? e.message : 'Failed to capture tab audio. Ensure you pick the actual tab and enable "Share tab audio".'
      setTabStatus(`error:${msg}`)
      alert(msg)
    }
  }

  const stopTabAudio = () => {
    try {
      mediaRecRef.current?.stop()
    } catch {}
    mediaRecRef.current = null
    try {
      tabStream?.getTracks()?.forEach(t => t.stop())
    } catch {}
    setTabStream(null)
  }

  // Windows polling
  useEffect(() => {
    if (!sessionId) return
    const poll = async () => {
      try {
        const r = await fetch(`/api/session/${sessionId}/windows?sizeMs=${winSizeMs}`)
        const j = await r.json()
        setWindows(j.windows || [])
      } catch {}
    }
    const id = setInterval(poll, 5000)
    poll()
    return () => clearInterval(id)
  }, [sessionId, winSizeMs])

  const toggleWindow = (idx) => {
    setSelectedWindows(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  const summarizeSelected = async () => {
    if (!sessionId || selectedWindows.size === 0) return
    const body = { windows: Array.from(selectedWindows).sort((a,b)=>a-b) }
    const r = await fetch(`/api/session/${sessionId}/summarize-windows?sizeMs=${winSizeMs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const j = await r.json().catch(()=>({}))
    setWindowSummary(j.summary || '')
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <h2>Meeting Assistant</h2>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <section>
            <h3>Provider Settings</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <label htmlFor="provider-select">Provider:</label>
              <select id="provider-select" value={provider} onChange={handleProviderChange}>
                <option value="codex">Codex/OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>

              <label htmlFor="model-select">Model:</label>
              <select id="model-select" value={selectedModel} onChange={handleModelChange}>
                {provider === 'codex' && (
                  <>
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                    <option value="gpt-4o">gpt-4o</option>
                    <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
                  </>
                )}
                {provider === 'gemini' && (
                  <>
                    <option value="gemini-pro">gemini-pro</option>
                    <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                    <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                  </>
                )}
              </select>
            </div>
          </section>

          <section>
            <h3>Transcript</h3>
            {!supported && <p>Your browser does not support SpeechRecognition. Use Chrome/Edge.</p>}
            
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: '#555' }}>Input Device (for Meter & Verification):</label>
              <select 
                value={selectedDeviceId} 
                onChange={e => { setSelectedDeviceId(e.target.value); stopInputMeter(); }}
                style={{ width: '100%', maxWidth: 400 }}
              >
                {audioDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Device ${d.deviceId.slice(0,8)}...`}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                Note: Chrome uses your <b>System Default</b> for transcription. If meter moves but no text appears, set this device as Default in Windows Sound Settings.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <button onClick={startMic} disabled={listening}>Start Mic</button>
              <button onClick={() => { useServerAsr ? stopServerMic() : stop(); stopInputMeter() }} disabled={!listening}>Stop Mic</button>
              <button onClick={() => { setTranscript(''); prevLenRef.current = 0; }}>Clear</button>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={autoRestart} onChange={e=>setAutoRestart(e.target.checked)} /> Auto‑restart mic
              </label>
            </div>
            <div style={{ color: '#666', fontSize: 12, marginBottom: 4 }}>Mic status: {micStatus}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 160, height: 10, background: '#eee', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, Math.round(meterLevel*100))}%`, height: '100%', background: meterLevel > 0.6 ? '#d33' : meterLevel > 0.3 ? '#fa3' : '#0a7' }} />
              </div>
              <span style={{ color: '#666', fontSize: 12 }}>Input level — {Math.round(meterLevel*100)}% {meterLabel ? `(${meterLabel})` : ''}</span>
            </div>
            {interimText && (
              <div style={{ color: '#999', fontSize: 12, fontStyle: 'italic', marginBottom: 8 }}>Interim: {interimText}</div>
            )}
            <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={12} style={{ width: '100%' }} />
          </section>

          <section style={{ marginTop: 16 }}>
            <h3>Session</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button onClick={finalize} disabled={!sessionId}>Finalize</button>
              <button onClick={()=>setShowAdvanced(v=>!v)}>{showAdvanced ? 'Hide Advanced' : 'Show Advanced'}</button>
            </div>
            <div style={{ marginBottom: 8, color: connected ? '#0a7' : '#b00' }}>
              {connected ? `Connected — interval ${Math.floor(intervalMs/1000)}s — ${Date.now() - lastSentAt < 20000 ? 'fresh speech detected' : 'waiting for fresh speech'}` : 'Not connected'}
            </div>
            <div>
              <label>Tick Prompt</label>
              <textarea value={tickPrompt} onChange={(e) => setTickPrompt(e.target.value)} rows={6} style={{ width: '100%' }} />
              <div style={{ marginTop: 6 }}>
                <button onClick={applyPrompt} disabled={ticking}>Apply Prompt</button>
              </div>
            </div>
          </section>
        </div>

        <div style={{ flex: 1 }}>
          <section>
            <h3>Live Suggestions (every ~20s)</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(suggestions.map(s => `- ${s.text}`).join('\n'))} disabled={!suggestions.length}>Copy All</button>
            </div>
            <div style={{ border: '1px solid #ddd', padding: 8, borderRadius: 6, minHeight: 240 }}>
              {suggestions.length === 0 && <p>No suggestions yet. Start session and connect stream.</p>}
              {suggestions.map((s, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ color: '#666', fontSize: 12 }}>{s.at}</div>
                  <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.text}</pre>
                </div>
              ))}
            </div>
          </section>

          {showAdvanced && (
          <section style={{ marginTop: 16 }}>
            <h3>20s Windows (pick and summarize)</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <label>Window size (ms):</label>
              <input type="number" value={winSizeMs} onChange={e=>setWinSizeMs(Number(e.target.value)||20000)} style={{ width: 120 }} />
              <button onClick={()=>setSelectedWindows(new Set())}>Clear Selection</button>
              <button onClick={summarizeSelected} disabled={!sessionId || selectedWindows.size===0}>Summarize Selected</button>
              <button onClick={()=>navigator.clipboard.writeText(windowSummary)} disabled={!windowSummary}>Copy Summary</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {windows.map(w => (
                <label key={w.index} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, display: 'block' }}>
                  <input type="checkbox" checked={selectedWindows.has(w.index)} onChange={()=>toggleWindow(w.index)} />{' '}
                  <strong style={{ fontSize: 12 }}>{`${(w.startMs/1000).toFixed(0)}s – ${(w.endMs/1000).toFixed(0)}s`}</strong>
                  <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{(w.text || '').slice(0, 120) || '—'}</div>
                </label>
              ))}
            </div>
            {windowSummary && (
              <div style={{ border: '1px solid #ddd', padding: 8, borderRadius: 6, marginTop: 8 }}>
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{windowSummary}</pre>
              </div>
            )}
          </section>
          )}

          <section style={{ marginTop: 16 }}>
            <h3>Final Summary</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(finalSummary)} disabled={!finalSummary}>Copy</button>
            </div>
            <div style={{ border: '1px solid #ddd', padding: 8, borderRadius: 6, minHeight: 120 }}>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{finalSummary}</pre>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
