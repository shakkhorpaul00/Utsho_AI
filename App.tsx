
import React, { useState, useEffect, useRef } from 'react';
import { Send, Plus, MessageSquare, Trash2, Menu, X, Sparkles, LogOut, Facebook, ShieldCheck, Zap, Globe, RefreshCcw, Settings, Key, ExternalLink, Mail, CheckCircle2, ArrowRight, Cloud, CloudOff, AlertTriangle, ShieldAlert, Calendar } from 'lucide-react';
import { ChatSession, Message, UserProfile, Gender } from './types';
import { streamChatResponse, checkApiHealth, fetchFreshKey } from './services/geminiService';
import * as db from './services/firebaseService';

const App: React.FC = () => {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiStatusText, setApiStatusText] = useState<string>('Ready');
  const [connectionHealth, setConnectionHealth] = useState<'perfect' | 'warning' | 'error'>('perfect');
  const [isSyncing, setIsSyncing] = useState(false);
  const [dbStatus, setDbStatus] = useState<boolean>(db.isDatabaseEnabled());
  
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3 | 4>(1);
  const [onboardingEmail, setOnboardingEmail] = useState('');
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingAge, setOnboardingAge] = useState<string>('');
  const [onboardingGender, setOnboardingGender] = useState<Gender | null>(null);
  const [customKeyInput, setCustomKeyInput] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bootApp = async () => {
      setApiStatusText('Booting...');
      await fetchFreshKey();
      setDbStatus(db.isDatabaseEnabled());

      const localProfile = localStorage.getItem('utsho_profile');
      if (localProfile) {
        const profile = JSON.parse(localProfile) as UserProfile;
        setUserProfile(profile);
        setCustomKeyInput(profile.customApiKey || '');
        
        if (db.isDatabaseEnabled()) {
          setIsSyncing(true);
          try {
            const cloudProfile = await db.getUserProfile(profile.email);
            if (cloudProfile) {
              setUserProfile(cloudProfile);
              setCustomKeyInput(cloudProfile.customApiKey || '');
            }
            const cloudSessions = await db.getSessions(profile.email);
            setSessions(cloudSessions);
            if (cloudSessions.length > 0) setActiveSessionId(cloudSessions[0].id);
          } catch (e) {
            console.error("Sync error:", e);
          } finally {
            setIsSyncing(false);
          }
        }
        await performHealthCheck(profile.customApiKey);
      }
    };
    bootApp();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      setIsSyncing(true);
      const profile = await db.loginWithGoogle();
      if (profile) {
        const existingCloudProfile = await db.getUserProfile(profile.email);
        if (!existingCloudProfile) {
          setOnboardingEmail(profile.email);
          setOnboardingName(profile.name);
          setOnboardingStep(2);
        } else {
          setUserProfile(existingCloudProfile);
          localStorage.setItem('utsho_profile', JSON.stringify(existingCloudProfile));
          const cloudSessions = await db.getSessions(profile.email);
          setSessions(cloudSessions);
          if (cloudSessions.length > 0) setActiveSessionId(cloudSessions[0].id);
          else createNewSession(profile.email);
          await performHealthCheck(existingCloudProfile.customApiKey);
        }
      }
    } catch (e: any) {
      alert(`Login failed: ${e.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const finalizeOnboarding = async () => {
    if (!onboardingName || !onboardingEmail || !onboardingGender || !onboardingAge) return;
    setIsSyncing(true);
    const profile: UserProfile = {
      name: onboardingName,
      email: onboardingEmail.toLowerCase().trim(),
      gender: onboardingGender,
      age: parseInt(onboardingAge) || 20,
      picture: `https://ui-avatars.com/api/?name=${onboardingName}&background=${onboardingGender === 'male' ? '4f46e5' : 'db2777'}&color=fff`,
      customApiKey: ''
    };
    
    localStorage.setItem('utsho_profile', JSON.stringify(profile));
    setUserProfile(profile);
    
    if (dbStatus) {
      await db.saveUserProfile(profile);
    }
    
    createNewSession(profile.email);
    setIsSyncing(false);
    performHealthCheck();
  };

  const performHealthCheck = async (key?: string) => {
    setApiStatusText('Checking Nodes...');
    const isHealthy = await checkApiHealth(key);
    setConnectionHealth(isHealthy ? 'perfect' : 'error');
    setApiStatusText(isHealthy ? (key ? 'Personal Active' : 'Pool Active') : 'Node Error');
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, activeSessionId, isLoading]);

  const saveSettings = async () => {
    if (!userProfile) return;
    setIsSyncing(true);
    const updated = { ...userProfile, customApiKey: customKeyInput.trim() };
    setUserProfile(updated);
    localStorage.setItem('utsho_profile', JSON.stringify(updated));
    if (dbStatus) await db.saveUserProfile(updated);
    setIsSyncing(false);
    setIsSettingsOpen(false);
    await performHealthCheck(updated.customApiKey);
  };

  const createNewSession = (emailOverride?: string) => {
    const email = emailOverride || userProfile?.email;
    if (!email) return;
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      messages: [],
      createdAt: new Date(),
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
    if (dbStatus) db.saveSession(email, newSession);
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading || !activeSessionId || !userProfile) return;

    const currentSession = sessions.find(s => s.id === activeSessionId);
    if (!currentSession) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: inputText,
      timestamp: new Date(),
    };

    const aiMessageId = crypto.randomUUID();
    const updatedMessages = [...currentSession.messages, userMessage];
    const tempAiMessage: Message = { id: aiMessageId, role: 'model', content: '', timestamp: new Date() };

    setInputText('');
    setIsLoading(true);

    setSessions(prev => prev.map(s => {
      if (s.id === activeSessionId) {
        return { 
          ...s, 
          messages: [...updatedMessages, tempAiMessage],
          title: s.messages.length === 0 ? userMessage.content.slice(0, 25) : s.title 
        };
      }
      return s;
    }));

    await streamChatResponse(
      [...updatedMessages], // Explicitly passing the full new history
      userProfile,
      (chunk) => {
        setSessions(prev => prev.map(s => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: s.messages.map(m => m.id === aiMessageId ? { ...m, content: m.content + chunk } : m)
            };
          }
          return s;
        }));
      },
      (fullText) => {
        setIsLoading(false);
        if (dbStatus) {
          const finalMessages = [...updatedMessages, { ...tempAiMessage, content: fullText }];
          db.updateSessionMessages(userProfile.email, activeSessionId, finalMessages);
        }
      },
      (error) => {
        setIsLoading(false);
        setConnectionHealth('error');
        setSessions(prev => prev.map(s => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: s.messages.map(m => m.id === aiMessageId ? { ...m, content: `⚠️ Error: ${error.message}` } : m)
            };
          }
          return s;
        }));
      },
      (status) => setApiStatusText(status)
    );
  };

  if (!userProfile || (onboardingStep > 1 && onboardingStep < 4)) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-10 shadow-2xl space-y-8">
          {onboardingStep === 1 ? (
            <div className="text-center space-y-6">
              <div className="flex justify-center"><div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center text-white floating-ai"><Sparkles size={32} /></div></div>
              <h1 className="text-3xl font-bold">Utsho AI</h1>
              <button onClick={handleGoogleLogin} className="w-full bg-white text-zinc-950 font-bold py-4 rounded-2xl flex items-center justify-center gap-3 hover:bg-zinc-100 transition-all">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="" />
                Sign in with Google
              </button>
            </div>
          ) : onboardingStep === 2 ? (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-center">Identity Confirmation</h2>
              <div className="space-y-4">
                <input type="text" value={onboardingName} onChange={e => setOnboardingName(e.target.value)} placeholder="Full Name" className="w-full bg-zinc-800 border border-zinc-700 rounded-2xl py-4 px-6 focus:ring-2 focus:ring-indigo-500 outline-none" />
                <input type="number" value={onboardingAge} onChange={e => setOnboardingAge(e.target.value)} placeholder="Your Age" className="w-full bg-zinc-800 border border-zinc-700 rounded-2xl py-4 px-6 focus:ring-2 focus:ring-indigo-500 outline-none" />
                <button onClick={() => setOnboardingStep(3)} disabled={!onboardingName || !onboardingAge} className="w-full bg-indigo-600 py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all">Next</button>
              </div>
            </div>
          ) : (
            <div className="space-y-8 text-center">
              <h2 className="text-2xl font-bold">Personality Choice</h2>
              <div className="grid grid-cols-2 gap-4">
                <button onClick={() => setOnboardingGender('male')} className={`p-6 rounded-3xl border-2 transition-all ${onboardingGender === 'male' ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-800/50'}`}>
                  <span className="text-4xl block mb-2">👦</span> Male
                </button>
                <button onClick={() => setOnboardingGender('female')} className={`p-6 rounded-3xl border-2 transition-all ${onboardingGender === 'female' ? 'border-pink-500 bg-pink-500/10' : 'border-zinc-800 bg-zinc-800/50'}`}>
                  <span className="text-4xl block mb-2">👧</span> Female
                </button>
              </div>
              <button onClick={finalizeOnboarding} disabled={!onboardingGender} className="w-full bg-white text-zinc-950 font-bold py-4 rounded-2xl shadow-xl">Get Started</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const isUserAdmin = db.isAdmin(userProfile.email);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden font-['Hind_Siliguri',_sans-serif]">
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setIsSettingsOpen(false)} />
          <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-8 space-y-6">
            <h3 className="text-xl font-bold">Settings</h3>
            <input type="password" value={customKeyInput} onChange={e => setCustomKeyInput(e.target.value)} placeholder="Gemini API Key (Optional)" className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm outline-none" />
            <div className="flex gap-4">
              <button onClick={() => setIsSettingsOpen(false)} className="flex-1 py-3 font-bold text-zinc-500">Cancel</button>
              <button onClick={saveSettings} className="flex-1 py-3 font-bold bg-indigo-600 rounded-xl">Save</button>
            </div>
          </div>
        </div>
      )}

      <aside className={`fixed md:relative z-50 inset-y-0 left-0 w-72 bg-zinc-900/50 backdrop-blur-xl border-r border-zinc-800 flex flex-col transition-transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-4 flex flex-col gap-4">
          <button onClick={() => createNewSession()} className="bg-zinc-100 text-zinc-950 py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 shadow-xl active:scale-95 transition-all"><Plus size={18} /> New Chat</button>
          <div className="p-3 bg-zinc-800/30 rounded-2xl border border-zinc-800 space-y-3">
             <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">{userProfile.customApiKey ? 'Personal Mode' : 'Smart Pool'}</span>
                <button onClick={() => setIsSettingsOpen(true)} className="text-zinc-500 hover:text-white"><Settings size={14} /></button>
             </div>
             <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${connectionHealth === 'perfect' ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500'}`} />
                <span className="text-[10px] uppercase font-bold text-zinc-500">{apiStatusText}</span>
             </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map(s => (
            <div key={s.id} onClick={() => setActiveSessionId(s.id)} className={`flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all ${activeSessionId === s.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/40'}`}>
              <MessageSquare size={16} />
              <div className="flex-1 truncate text-sm">{s.title || 'Conversation'}</div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-zinc-800">
          <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-zinc-800/20 border border-zinc-800/50">
            <img src={userProfile.picture} className="w-10 h-10 rounded-full border border-zinc-700" alt="" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold truncate flex items-center gap-1">{userProfile.name} {isUserAdmin && <ShieldAlert size={12} className="text-amber-400" />}</div>
              <div className="text-[9px] uppercase font-bold text-zinc-500">{userProfile.age}Y • {userProfile.gender === 'male' ? (userProfile.age >= 30 ? 'Respect' : 'Bro') : (userProfile.age >= 50 ? 'Mother' : 'Charm')}</div>
            </div>
            <button onClick={() => { localStorage.clear(); window.location.reload(); }} className="p-2 text-zinc-600 hover:text-red-400"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative pt-14 md:pt-0">
        <div className="md:hidden absolute top-0 inset-x-0 h-14 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800 z-40 flex items-center px-4">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2"><Menu size={20} /></button>
          <span className="flex-1 text-center font-bold text-sm">Utsho AI</span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-8">
          <div className="max-w-3xl mx-auto space-y-8">
            {activeSession?.messages.length === 0 ? (
              <div className="h-[60vh] flex flex-col items-center justify-center space-y-6 text-center animate-in fade-in zoom-in duration-700">
                <div className={`w-24 h-24 rounded-3xl flex items-center justify-center shadow-2xl ${userProfile.gender === 'male' ? 'bg-indigo-600' : 'bg-pink-600'}`}><Sparkles size={40} className="text-white" /></div>
                <div><h2 className="text-4xl font-black mb-2">Hello, {userProfile.name.split(' ')[0]}</h2><p className="text-zinc-500">I am your Utsho AI assistant. How can I help you today?</p></div>
              </div>
            ) : (
              activeSession?.messages.map(m => (
                <div key={m.id} className={`flex gap-4 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-in slide-in-from-bottom-2`}>
                  <div className={`p-4 rounded-2xl text-[16px] whitespace-pre-wrap bangla-text shadow-sm max-w-[85%] ${m.role === 'user' ? (userProfile.gender === 'male' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-pink-600 text-white rounded-tr-none') : 'bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-tl-none'}`}>
                    {m.content}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="p-4 md:p-8 bg-zinc-950/80 backdrop-blur-md border-t border-zinc-900/50">
          <div className="max-w-3xl mx-auto relative group">
            <div className="relative bg-zinc-900 rounded-[2rem] border border-zinc-800 p-1.5 flex items-end gap-2 shadow-2xl">
              <textarea rows={1} value={inputText} onChange={e => { setInputText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }} placeholder="Type your message..." className="flex-1 bg-transparent text-zinc-100 py-3 pl-5 pr-2 focus:outline-none transition-all resize-none max-h-40" />
              <button onClick={handleSendMessage} disabled={!inputText.trim() || isLoading} className={`p-3 rounded-full transition-all active:scale-90 ${inputText.trim() && !isLoading ? (userProfile.gender === 'male' ? 'bg-indigo-600' : 'bg-pink-600') : 'bg-zinc-800 text-zinc-600'}`}><Send size={20} /></button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
