import { useState, useEffect, useRef, useCallback } from 'react';
import { VoiceState, TranscriptTurn, RAGSource, ConsoleSettings } from '../types';
import { defaultApiService } from '../services/apiService';
import { AudioTelemetry } from '../components/WaveformVisualizer';

export type { AudioTelemetry };

// Minimal Web Speech API shapes (not part of lib.dom.d.ts) — just enough of
// the SpeechRecognition surface this hook actually touches.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
interface SpeechRecognitionWindow {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  webkitAudioContext?: typeof AudioContext;
}

/**
 * Drives the console's voice conversation state machine end to end: mic
 * capture -> Web Speech recognition -> /ask -> streaming answer -> TTS ->
 * back to listening. See README.md's "Voice Loop" section for the full
 * state diagram; the six `VoiceState` values and the one non-obvious part
 * of the flow are summarized here since this file is the actual source of
 * truth:
 *
 *   idle -> listening -> processing -> speaking -> (loops back to listening)
 *
 * Two different things can end a session, and they look similar but are
 * NOT the same code path:
 *   - `inactivity_countdown` — despite the name, this is entered only when
 *     a `processing` call to /ask throws (see the catch block in
 *     processQuery). It shows a visible countdown with a "stay active"
 *     escape hatch before moving to `ended`.
 *   - The actual silent no-speech timeout (`resetInactivityTimer`, driven
 *     by `settings.autoStandbySec`) jumps straight from `listening` to
 *     `ended` with no warning countdown — it's a separate timer, reset on
 *     every recognized utterance.
 *
 * `ended` only returns to `idle` via an explicit user action (resetSession,
 * wired to the "Start again" button) — never automatically.
 */
export function useVoiceEngine(
  sources: RAGSource[],
  settings: ConsoleSettings,
  onNewTurnAdded: (turn: TranscriptTurn) => void
) {
  // Voice State Machine
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [inactivitySecondsLeft, setInactivitySecondsLeft] = useState<number>(settings.autoStandbySec);
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [systemMessage, setSystemMessage] = useState<string>('Ready when you are.');
  const [statusStepCode, setStatusStepCode] = useState<string>('IDLE_STANDBY');

  // Mic & Audio Telemetry
  const [telemetry, setTelemetry] = useState<AudioTelemetry>({
    rmsVolume: 0,
    peakDb: -40,
    frequencyData: new Uint8Array(64),
    timeDomainData: new Uint8Array(64),
    micActive: false,
    hasPermission: true
  });

  const [spokenCharIndex, setSpokenCharIndex] = useState<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Web Speech Recognition & Synthesis Refs
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isSpeakingRef = useRef<boolean>(false);
  const speechSynthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const inactivityIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Rolling 6-turn conversation history for multi-turn context
  const conversationHistoryRef = useRef<Array<{ role: string; content: string }>>([]);

  // Controls gain scaling from settings
  const gainNodeRef = useRef<GainNode | null>(null);

  // Helper: Set status code and OLED message
  const setConsoleStatus = useCallback((code: string, msg: string) => {
    setStatusStepCode(code);
    setSystemMessage(msg);
  }, []);

  // Initialize Microphone Web Audio Analyser
  const initAudioContext = useCallback(async () => {
    try {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }

      if (!micStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        micStreamRef.current = stream;
        const AudioCtx = window.AudioContext || (window as unknown as SpeechRecognitionWindow).webkitAudioContext;
        const audioCtx = new AudioCtx!();
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;

        const gainNode = audioCtx.createGain();
        gainNode.gain.value = settings.micSensitivity / 50; // 0 to 2.0 scaling
        gainNodeRef.current = gainNode;

        source.connect(gainNode);
        gainNode.connect(analyser);
        analyserRef.current = analyser;

        setTelemetry(prev => ({ ...prev, hasPermission: true, micActive: true, errorMessage: undefined }));
      }
    } catch (err) {
      console.warn('Microphone access denied or unavailable:', err);
      setTelemetry(prev => ({
        ...prev,
        hasPermission: false,
        micActive: false,
        errorMessage: err instanceof Error ? err.message : 'MIC_ACCESS_DENIED'
      }));
      setConsoleStatus('MIC_PERM_ERR', 'Microphone access was denied — allow it in your browser to talk, or try the sample question instead.');
    }
  }, [settings.micSensitivity, setConsoleStatus]);

  // Telemetry animation loop (matches provided useAudioTelemetry logic)
  useEffect(() => {
    const updateTelemetry = () => {
      if (analyserRef.current && voiceState === 'listening') {
        const freqArr = new Uint8Array(analyserRef.current.frequencyBinCount);
        const timeArr = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteFrequencyData(freqArr);
        analyserRef.current.getByteTimeDomainData(timeArr);

        let sum = 0;
        for (let i = 0; i < timeArr.length; i++) {
          const sample = (timeArr[i] - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / timeArr.length);
        const scaledRms = Math.min(1.0, rms * (settings.micSensitivity / 40));

        setTelemetry({
          rmsVolume: scaledRms,
          peakDb: scaledRms > 0.001 ? Math.min(6, Math.max(-40, 20 * Math.log10(scaledRms) + 6)) : -40,
          frequencyData: freqArr,
          timeDomainData: timeArr,
          micActive: true,
          hasPermission: true
        });
      } else if (voiceState === 'speaking') {
        const mockFreq = new Uint8Array(64);
        const mockTime = new Uint8Array(64);
        const t = Date.now() / 100;
        for (let i = 0; i < 64; i++) {
          mockFreq[i] = Math.min(255, Math.max(0, Math.sin(t + i * 0.3) * 80 + 120));
          mockTime[i] = Math.min(255, Math.max(0, 128 + Math.sin(t + i * 0.5) * 60));
        }
        setTelemetry(prev => ({
          ...prev,
          rmsVolume: Math.sin(t) * 0.3 + 0.5,
          peakDb: -10,
          frequencyData: mockFreq,
          timeDomainData: mockTime,
          micActive: false
        }));
      } else {
        setTelemetry(prev => ({
          ...prev,
          rmsVolume: 0.02,
          peakDb: -38,
          micActive: false
        }));
      }

      animFrameRef.current = requestAnimationFrame(updateTelemetry);
    };

    animFrameRef.current = requestAnimationFrame(updateTelemetry);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [voiceState, settings.micSensitivity]);

  // Handle Voice Inactivity Countdown
  useEffect(() => {
    if (voiceState === 'inactivity_countdown') {
      // Stop recognition and TTS before starting countdown
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* already stopped */ }
        recognitionRef.current = null;
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();

      setInactivitySecondsLeft(settings.autoStandbySec);
      setConsoleStatus('STANDBY_COUNTDOWN', `Ending in ${settings.autoStandbySec}s — stay active to continue.`);

      inactivityIntervalRef.current = setInterval(() => {
        setInactivitySecondsLeft(prev => {
          if (prev <= 1) {
            clearInterval(inactivityIntervalRef.current!);
            setVoiceState('ended');
            setConsoleStatus('SESSION_ENDED', 'Session ended — start again to continue.');
            return 0;
          }
          const next = prev - 1;
          setConsoleStatus('STANDBY_COUNTDOWN', `Ending in ${next}s — stay active to continue.`);
          return next;
        });
      }, 1000);
    } else {
      if (inactivityIntervalRef.current) {
        clearInterval(inactivityIntervalRef.current);
        inactivityIntervalRef.current = null;
      }
    }

    return () => {
      if (inactivityIntervalRef.current) clearInterval(inactivityIntervalRef.current);
    };
  }, [voiceState, settings.autoStandbySec, setConsoleStatus]);

  // Stable ref so startListeningRecognition can call processQuery without stale closure
  // Declared before startListeningRecognition to avoid reference-before-use
  const processQueryRef = useRef<(q: string) => void>(() => {});
  const isFirstRecognitionRef = useRef<boolean>(true);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);

  const resetInactivityTimer = useCallback(() => {
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* already stopped */ }
        recognitionRef.current = null;
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      setVoiceState('ended');
      setConsoleStatus(
        'SESSION_ENDED',
        `Session ended due to ${settings.autoStandbySec} seconds of inactivity — start again to continue.`
      );
    }, settings.autoStandbySec * 1000);
  }, [settings.autoStandbySec, clearInactivityTimer, setConsoleStatus]);

  // Internal: restart recognition after TTS ends (defined before processQuery)
  const startListeningRecognition = useCallback(() => {
    const speechWindow = window as unknown as SpeechRecognitionWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* already stopped */ }
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const SILENCE_MS = 1500;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      resetInactivityTimer(); // speech detected — reset the auto-standby clock

      let currentInterim = '';
      let finalUtterance = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalUtterance += t;
        else currentInterim += t;
      }

      const displayText = finalUtterance || currentInterim;
      if (displayText) {
        setInterimTranscript(displayText);
        setConsoleStatus('RECEIVING_SIGNAL', `Hearing "${displayText}"`);
      }

      if (finalUtterance) {
        // Browser marked it final — submit immediately
        try { recognition.stop(); } catch { /* already stopped */ }
        processQueryRef.current(finalUtterance);
      } else if (currentInterim) {
        // Start silence timer — if no new result in SILENCE_MS, treat interim as final
        silenceTimer = setTimeout(() => {
          try { recognition.stop(); } catch { /* already stopped */ }
          processQueryRef.current(currentInterim);
        }, SILENCE_MS);
      }
    };

    recognition.onerror = (e: SpeechRecognitionErrorEventLike) => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setConsoleStatus('SPEECH_RECOG_ERR', `Voice recognition hit a snag (${e.error}) — try again.`);
      }
    };

    recognition.onend = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    };

    recognitionRef.current = recognition;
    resetInactivityTimer();
    const delay = isFirstRecognitionRef.current ? 600 : 0;
    isFirstRecognitionRef.current = false;
    setTimeout(() => { try { recognition.start(); } catch { /* already started */ } }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConsoleStatus]);

  // Execute Question Processing -> Streaming TTS Pipeline
  const processQuery = useCallback(async (userQueryText: string) => {
    if (!userQueryText || !userQueryText.trim()) {
      setVoiceState('listening');
      setConsoleStatus('MIC_ACTIVE', 'Listening — go ahead.');
      return;
    }

    setVoiceState('processing');
    setConsoleStatus('RAG_PROCESSING', 'Searching your sources...');
    setInterimTranscript('');
    clearInactivityTimer();

    // Stop recognition BEFORE TTS — must not capture our own TTS output
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* already stopped */ }
      recognitionRef.current = null;
    }

    try {
      const activeSources = sources.filter(s => s.status === 'indexed');

      const result = await defaultApiService.askQuestion(
        userQueryText,
        activeSources,
        settings,
        conversationHistoryRef.current
      );

      // Update rolling history
      conversationHistoryRef.current = [
        ...conversationHistoryRef.current,
        { role: 'user', content: userQueryText },
        { role: 'assistant', content: result.responseText }
      ].slice(-12);

      const audioDuration = Math.max(3, Math.round(result.responseText.length / 15));

      const newTurn: TranscriptTurn = {
        id: `turn-${Date.now()}`,
        timestamp: new Date(),
        userSpeechText: userQueryText,
        aiResponseText: result.responseText,
        citations: result.citations,
        audioDurationSeconds: audioDuration,
        ragLatencyMs: result.ragLatencyMs
      };

      onNewTurnAdded(newTurn);

      setVoiceState('speaking');
      setConsoleStatus('TTS_SPEAKING', 'Speaking...');

      speakText(result.responseText, () => {
        setVoiceState('listening');
        setConsoleStatus('MIC_ACTIVE', 'Listening — go ahead.');
        startListeningRecognition();
      });

    } catch (err) {
      console.error('Error processing query:', err);
      setConsoleStatus('RAG_ERROR', 'Something went wrong answering that — ending the session shortly.');
      setVoiceState('inactivity_countdown');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, settings, onNewTurnAdded, setConsoleStatus]);

  // Web Speech API Synthesis function
  const speakText = useCallback((text: string, onEndCallback: () => void) => {
    if (!('speechSynthesis' in window)) {
      setTimeout(onEndCallback, Math.max(2500, text.length * 60));
      return;
    }

    window.speechSynthesis.cancel();

    // Chromium bug: calling speak() synchronously after cancel() drops the
    // utterance after the first word. A single-tick delay reliably avoids it.
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.pitch = settings.speechPitch;
      utterance.rate = settings.speechRate;
      utterance.volume = settings.masterVolume / 100;

      if (settings.selectedVoiceId) {
        const voices = window.speechSynthesis.getVoices();
        const found = voices.find(v => v.name === settings.selectedVoiceId || v.voiceURI === settings.selectedVoiceId);
        if (found) utterance.voice = found;
      }

      utterance.onboundary = (e: SpeechSynthesisEvent) => {
        if (e.name === 'word') setSpokenCharIndex(e.charIndex);
      };

      const finish = () => {
        clearInterval(keepAlive);
        isSpeakingRef.current = false;
        setSpokenCharIndex(null);
        onEndCallback();
      };

      utterance.onend = finish;
      utterance.onerror = (e) => {
        console.warn('SpeechSynthesis error:', e);
        finish();
      };

      // Chromium bug: utterances longer than ~15s silently stop and never fire
      // onend. Calling pause()/resume() every 10s resets the internal timer.
      const keepAlive = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        } else {
          clearInterval(keepAlive);
        }
      }, 10000);

      isSpeakingRef.current = true;
      speechSynthRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    }, 50);
  }, [settings.speechPitch, settings.speechRate, settings.masterVolume, settings.selectedVoiceId]);

  // Keep processQueryRef in sync with the latest processQuery closure
  useEffect(() => { processQueryRef.current = processQuery; }, [processQuery]);

  // Web Speech Recognition setup (initial "Start Conversation" entry point)
  const startListening = useCallback(async () => {
    await initAudioContext();
    setVoiceState('listening');
    setConsoleStatus('MIC_ACTIVE', 'Listening — go ahead.');
    setInterimTranscript('');
    startListeningRecognition();
  }, [initAudioContext, setConsoleStatus, startListeningRecognition]);

  // Stop / Pause conversation
  const stopConversation = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* already stopped */ }
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    setVoiceState('idle');
    setConsoleStatus('IDLE_STANDBY', 'Ready when you are.');
    setInterimTranscript('');
    clearInactivityTimer();
  }, [setConsoleStatus, clearInactivityTimer]);

  // Manual Trigger Query (Physical Console Push-to-Talk / Simulated Prompt)
  const triggerManualQuery = useCallback((customQueryText?: string) => {
    const sampleQueries = [
      "What are the main architecture components of SONAR RAG?",
      "How do the stereo VU meter ballistics function?",
      "Summarize the active uploaded sources in memory.",
      "Explain how vector retrieval latency is optimized during live speech."
    ];
    const queryToUse = customQueryText || sampleQueries[Math.floor(Math.random() * sampleQueries.length)];
    
    setInterimTranscript(queryToUse);
    processQuery(queryToUse);
  }, [processQuery]);

  // Reset session
  const resetSession = useCallback(() => {
    stopConversation();
    setVoiceState('idle');
    setInactivitySecondsLeft(settings.autoStandbySec);
    conversationHistoryRef.current = [];
    isFirstRecognitionRef.current = true;
    clearInactivityTimer();
  }, [stopConversation, settings.autoStandbySec, clearInactivityTimer]);

  // Stop speech if state changes from speaking manually
  useEffect(() => {
    if (voiceState !== 'speaking' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [voiceState]);

  return {
    voiceState,
    setVoiceState,
    inactivitySecondsLeft,
    interimTranscript,
    systemMessage,
    statusStepCode,
    telemetry,
    spokenCharIndex,
    startListening,
    stopConversation,
    triggerManualQuery,
    resetSession,
    processQuery
  };
}
