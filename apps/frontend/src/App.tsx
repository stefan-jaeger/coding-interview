import { useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import SockJS from 'sockjs-client'
import Stomp from 'stompjs'
import { v4 as uuidv4 } from 'uuid'

const langs = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'java', label: 'Java' }
]

function hslToHex(h: number, s: number, l: number) {
  s /= 100
  l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hh = h / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (0 <= hh && hh < 1) { r = c; g = x; b = 0 }
  else if (1 <= hh && hh < 2) { r = x; g = c; b = 0 }
  else if (2 <= hh && hh < 3) { r = 0; g = c; b = x }
  else if (3 <= hh && hh < 4) { r = 0; g = x; b = c }
  else if (4 <= hh && hh < 5) { r = x; g = 0; b = c }
  else if (5 <= hh && hh < 6) { r = c; g = 0; b = x }
  const m = l - c / 2
  const R = Math.round((r + m) * 255)
  const G = Math.round((g + m) * 255)
  const B = Math.round((b + m) * 255)
  return `#${[R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function normalizeColor(col?: string) {
  if (!col) return randomColor()
  col = col.trim()
  if (col.startsWith('#')) return col
  if (col.startsWith('hsl')) {
    const m = col.match(/hsl\((\d+(?:\.\d+)?),\s*(\d+)%?,\s*(\d+)%?\)/i)
    if (m) {
      const h = Number(m[1])
      const s = Number(m[2])
      const l = Number(m[3])
      return hslToHex(h, s, l)
    }
  }
  if (col.startsWith('rgb')) {
    const m = col.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)/i)
    if (m) {
      const R = Number(m[1])
      const G = Number(m[2])
      const B = Number(m[3])
      return `#${[R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')}`
    }
  }
  return col
}

function randomColor(seed?: string) {
  const x = seed ? Array.from(seed).reduce((a, c) => a + c.charCodeAt(0), 0) : Math.random() * 1000
  const h = x % 360
  const s = 70
  const l = 55
  return hslToHex(h, s, l)
}

export default function App() {
  const params = new URLSearchParams(location.search)
  const initialName = ''
  const [name, setName] = useState(initialName)
  const [sessionId, setSessionId] = useState<string>('')
  function shortId(n=8){
    return Math.random().toString(36).slice(2,2+n)
  }
  const [lang, setLang] = useState<string>('javascript')
  const [color, setColor] = useState<string>(() => normalizeColor(randomColor((initialName) ? initialName : uuidv4())))
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const stompRef = useRef<Stomp.Client | null>(null)
  const userId = useMemo(() => uuidv4(), [])
  const [output, setOutput] = useState('')
  const [executing, setExecuting] = useState(false)
  const [participants, setParticipants] = useState<{userId:string,name:string,color:string}[]>([])
  const [selectionStyles, setSelectionStyles] = useState<Record<string, string>>({})
  const decorationIdsRef = useRef<Record<string, string[]>>({})
  const initialLanguageSetRef = useRef(false)
  const [askedName, setAskedName] = useState<boolean>(!!initialName)
  const isLocalLangChangeRef = useRef(false) 

  const [toast, setToast] = useState('')
  const examples: Record<string,string> = {
    javascript: `// JS example\nfunction add(a,b){return a+b}\nconsole.log('sum=', add(2,3))`,
    typescript: `// TS example\nfunction add(a: number, b: number): number { return a + b }\nconsole.log('sum=', add(2,3))`,
    java: `public class Main {\n  public static void main(String[] args){\n    System.out.println(\"Hello Java\");\n  }\n}`
  } as any

  useEffect(() => {
    let sid = location.pathname.split('/s/')[1]
    if (!sid) sid = shortId(10)
    sid = sid.split('?')[0]
    setSessionId(sid)
    if (!location.pathname.includes('/s/')) {
      const url = `/s/${sid}`
      history.replaceState({}, '', url)
    }
  }, [])

  useEffect(() => {
    if (!askedName) return
    const container = document.getElementById('editor')!
    const initialModel = monaco.editor.createModel('', 'plaintext', monaco.Uri.parse(`inmemory://model/${sessionId || shortId(10)}.txt`))
    const editor = monaco.editor.create(container, {
      model: initialModel,
      automaticLayout: true,
      minimap: { enabled: false },
      theme: 'vs-dark'
    })
    editorRef.current = editor

    let stomp: Stomp.Client | null = null
    function connectWs() {
      if (!askedName || !name) return
      const sock = new SockJS('/ws')
      stomp = Stomp.over(sock)
      stomp.debug = () => {}
      stomp.connect({}, () => {
        stomp!.subscribe(`/topic/session.${sessionId}`, (msg) => {
          const m = JSON.parse(msg.body)

          if (m.type === 'session_init' && m.userId === userId && m.isNew) {
            // Only set default template for the first user in a new session
            const initial = examples[lang] || ''
            editor.setValue(initial)
            stomp!.send('/app/content', {}, JSON.stringify({ sessionId, value: initial, userId }))
            stomp!.send('/app/language', {}, JSON.stringify({ sessionId, language: lang, userId }))
          }
          if (m.type === 'language') {
            const oldModel = editor.getModel()!
            const ext = m.language === 'javascript' ? 'js' : (m.language === 'typescript' ? 'ts' : (m.language === 'java' ? 'java' : m.language))
            const uri = monaco.Uri.parse(`inmemory://model/${sessionId}.${ext}`)
            let newModel = monaco.editor.getModel(uri)
            if (!newModel) {
              const value = oldModel ? oldModel.getValue() : ''
              newModel = monaco.editor.createModel(value, m.language, uri)
            } else {
              monaco.editor.setModelLanguage(newModel, m.language)
            }
            editor.setModel(newModel)
            if (oldModel && oldModel !== newModel && oldModel.uri.toString().startsWith('inmemory://model/')) {
              try { oldModel.dispose() } catch (_) {}
            }
            if (m.language !== 'typescript' && m.language !== 'javascript') {
              monaco.editor.setModelMarkers(newModel, 'typescript', [])
              monaco.editor.setModelMarkers(newModel, 'javascript', [])
            }
            if (m.userId !== userId) {
              isLocalLangChangeRef.current = false
            }
            setLang(m.language)
            initialLanguageSetRef.current = true
          }
          if (m.type === 'content' && m.userId !== userId) {
            const model = editor.getModel()
            if (model && model.getValue() !== m.value) {
              // Only set content after language is properly set
              if (initialLanguageSetRef.current) {
                model.setValue(m.value)
              } else {
                // Wait a tiny bit for language to be set, then set content
                setTimeout(() => {
                  model.setValue(m.value)
                }, 10)
              }
            }
          }
          if (m.type === 'cursor' && m.userId !== userId) {
            const decorations: monaco.editor.IModelDeltaDecoration[] = []

            // Add cursor decoration
            decorations.push({
              range: new monaco.Range(m.position.lineNumber, m.position.column, m.position.lineNumber, m.position.column),
              options: {
                className: 'remote-cursor',
                overviewRuler: { color: m.color, position: monaco.editor.OverviewRulerLane.Full },
                after: { content: ` ${m.name}`, inlineClassName: `remote-cursor-label user-${m.userId}` },
              }
            })
            
            // Add selection decoration if there is a selection
            if (m.selection && m.selection.startLineNumber) {
              const selectionRange = new monaco.Range(
                m.selection.startLineNumber,
                m.selection.startColumn,
                m.selection.endLineNumber,
                m.selection.endColumn
              )
              
              // Only add selection decoration if it's not empty (not just a cursor)
              if (!selectionRange.isEmpty()) {
                decorations.push({
                  range: selectionRange,
                  options: {
                    inlineClassName: `remote-selection user-${m.userId}`,
                    overviewRuler: { color: m.color, position: monaco.editor.OverviewRulerLane.Full },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                  }
                })
              }
            }
            
            // Update decorations and store the IDs
            const oldDecorationIds = decorationIdsRef.current[`remote-${m.userId}`] || []
            const newDecorationIds = editor.deltaDecorations(oldDecorationIds, decorations)
            decorationIdsRef.current[`remote-${m.userId}`] = newDecorationIds
          }
          if (m.type === 'join') {
            const normalized = normalizeColor(m.color)
            setParticipants(prev => {
              const found = prev.find((p: {userId:string,name:string,color:string}) => p.userId === m.userId)
              if (found) {
                return prev.map((p: {userId:string,name:string,color:string}) => p.userId === m.userId ? { ...p, name: m.name, color: normalized } : p)
              }
              return [...prev, { userId: m.userId, name: m.name, color: normalized }]
            })
          }
          if (m.type === 'participants') {
            const list = (m.list || []).map((p: any) => ({ userId: p.userId, name: p.name, color: normalizeColor(p.color) }))
            setParticipants(list)
            const me = list.find((p: {userId:string,name:string,color:string}) => p.userId === userId)
            if (me) {
              const normalized = normalizeColor(me.color)
              if (normalized && normalized !== color) {
                setColor(normalized)
              }
            }
          }
          if (m.type === 'exec_start') {
            setExecuting(true)
            setOutput('Executing code...')
          }
          if (m.type === 'output') {
            setOutput((m.error ? `Error:\n${m.error}` : m.output) || '')
            setExecuting(false)
          }
          if (m.type === 'leave') {
            setParticipants(prev => prev.filter((p: {userId:string,name:string,color:string}) => p.userId !== m.userId))
          }
        })
        stompRef.current = stomp!
        stomp!.send(`/app/join`, {}, JSON.stringify({ sessionId, name, color, userId }))
        setParticipants(prev => prev.some((p: {userId:string,name:string,color:string}) => p.userId === userId) ? prev : [...prev, { userId, name, color: normalizeColor(color) }])
        stomp!.send(`/app/participants`, {}, JSON.stringify({ sessionId }))

        const model = editor.getModel()!
        // Request current session state from the server immediately
        stomp!.send(`/app/participants`, {}, JSON.stringify({ sessionId }))
      }, (err) => {
        console.error('WS error', err)
      })
    }

    connectWs()

    const sub1 = editor.onDidChangeModelContent(() => {
      if (!stomp || !stomp.connected) return
      const value = editor.getValue()
      stomp.send('/app/content', {}, JSON.stringify({ sessionId, value, userId }))
    })
    const sub2 = editor.onDidChangeCursorSelection((e) => {
      if (!stomp || !stomp.connected) return
      const sel = e.selection
      const pos = editor.getPosition()
      stomp.send('/app/cursor', {}, JSON.stringify({ sessionId, userId, name, color, position: pos, selection: sel }))
    })

    return () => {
      sub1.dispose(); sub2.dispose(); editor.dispose(); if (stomp && stomp.connected) stomp.disconnect(() => {})
    }
  }, [sessionId, askedName, name])

  useEffect(() => {
    if (!askedName) return
    if (!editorRef.current) return
    const model = editorRef.current.getModel()!
    monaco.editor.setModelLanguage(model, lang)
    
    // Only set the template if this is a local language change by the user
    if (isLocalLangChangeRef.current) {
      const val = examples[lang] || ''
      editorRef.current.setValue(val)
      if (stompRef.current && (stompRef.current as any).connected) {
        stompRef.current.send('/app/language', {}, JSON.stringify({ sessionId, language: lang, userId }))
        stompRef.current.send('/app/content', {}, JSON.stringify({ sessionId, value: val, userId }))
      }
      isLocalLangChangeRef.current = false
    }
    
    if (lang !== 'typescript' && lang !== 'javascript') {
      monaco.editor.setModelMarkers(model, 'typescript', [])
      monaco.editor.setModelMarkers(model, 'javascript', [])
    }
  }, [lang, askedName])

  // Create dynamic CSS for user selection colors
  useEffect(() => {
    if (participants.length === 0) return
    
    let styleSheet = document.getElementById('user-selection-styles')
    if (!styleSheet) {
      styleSheet = document.createElement('style')
      styleSheet.id = 'user-selection-styles'
      document.head.appendChild(styleSheet)
    }
    
    const styleContent = participants.map((p: {userId:string,name:string,color:string}) => 
      `.remote-selection.user-${p.userId} { 
         background: ${p.color} !important;
         color: white !important;
         opacity: 0.7 !important;
         border-radius: 2px;
       }`
    ).join('\n')
    
    styleSheet.textContent = styleContent
  }, [participants])

  function run() {
    const code = editorRef.current?.getValue() || ''
    setExecuting(true)
    setOutput('Executing code...')
    fetch('/api/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, language: lang, code }) })
      .then(r => r.json())
      .then(r => setOutput((r.error ? `Error:\n${r.error}` : r.output) || ''))
      .catch(() => setOutput('Error: failed to execute'))
      .finally(() => setExecuting(false))
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100vh' }}>
      {!askedName && (
        <div className="modal">
          <div className="modal-card">
            <h3>Enter your name</h3>
            <input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=> { if (e.key === 'Enter') setAskedName(true) }} style={{ width: '100%', marginTop: 8 }} />
            <button style={{ marginTop: 12, width: '100%' }} onClick={()=> setAskedName(true)}>Join</button>
          </div>
        </div>
      )}
      {askedName && (
        <>
          <div className="sidebar">
            <div className="toolbar">
              <select value={lang} onChange={e => {
                isLocalLangChangeRef.current = true
                setLang(e.target.value)
              }}>
                {langs.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <button onClick={run}>Run</button>
            </div>
            <h3>Participants</h3>
            <div className="list">
              {participants.map((p: {userId:string,name:string,color:string}) => (
                <div key={p.userId} className="participant">
                  <span className="dot" style={{ background: p.color }} />
                  <span>{p.name || 'Anonymous'}</span>
                </div>
              ))}
            </div>
            <div className="status" style={{display:'flex',flexDirection:'column',gap:6}}>
              <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'space-between'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span>You: {name || 'Anonymous'}</span>
                  <input title="Pick your color" type="color" value={normalizeColor(color)} onChange={e=>{
                    const raw = (e.target as HTMLInputElement).value
                    const c = normalizeColor(raw)
                    setColor(c)
                    setParticipants(prev => prev.map((p: {userId:string,name:string,color:string}) => p.userId===userId ? {...p, color: c} : p))
                    if (stompRef.current && (stompRef.current as any).connected) {
                      stompRef.current.send(`/app/join`, {}, JSON.stringify({ sessionId, name, color: c, userId }))
                    }
                  }} style={{width:34,height:26,border:'none',padding:0,background:'transparent'}} />
                </div>
                <button style={{padding:'4px 6px',fontSize:12}} onClick={()=> { setName(''); setAskedName(false) }}>Change</button>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span>Session: <code style={{background:'transparent',color:'var(--text)'}}>{sessionId}</code></span>
                <button title="Copy session link" style={{padding:'4px 6px',fontSize:12}} onClick={()=> { navigator.clipboard.writeText(`${location.origin}/s/${sessionId}`); setToast('Link copied'); setTimeout(()=> setToast(''), 1200) }}>Copy</button>
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr 240px' }}>
            <div className="toolbar">Ready</div>
            <div id="editor" style={{ height: '100%' }} />
            <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', borderTop: '1px solid var(--border)' }}>
              <div className="toolbar"><span style={{ color: 'var(--muted)' }}>Output</span></div>
              <pre style={{ margin: 0, padding: 12, background: '#0c0f17', color: 'var(--text)', overflow: 'auto', height: '100%' }}>{output || (executing ? 'Executing code...' : ' ')}</pre>
            </div>
          </div>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
