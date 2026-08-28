import React, { useEffect, useRef } from 'react';
import { VoiceState } from '../types';

export interface AudioTelemetry {
  rmsVolume: number;
  peakDb: number;
  frequencyData: Uint8Array;
  timeDomainData: Uint8Array;
  micActive: boolean;
  hasPermission: boolean;
  errorMessage?: string;
}

interface WaveformVisualizerProps {
  voiceState: VoiceState;
  telemetry: AudioTelemetry;
  height?: number;
  inactivitySecondsLeft?: number;
}

// How long a state's drawing takes to fade fully in after switching —
// keeps idle -> listening -> processing -> speaking from popping abruptly.
const TRANSITION_MS = 380;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({
  voiceState,
  telemetry,
  height = 180,
  inactivitySecondsLeft = 15
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const transitionStart = Date.now();

    const render = () => {
      const width = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, width, h);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(width, h / 2);
      ctx.stroke();

      const time = Date.now() / 150;

      // Smoothly fade the new state's drawing in rather than snapping —
      // makes idle -> listening -> processing -> speaking feel continuous.
      const elapsed = Date.now() - transitionStart;
      ctx.globalAlpha = easeOutCubic(Math.min(1, elapsed / TRANSITION_MS));

      if (voiceState === 'listening') {
        const cyan = '#00e5ff';

        const freq = telemetry.frequencyData;
        const barCount = 36;
        const barWidth = width / barCount;

        for (let i = 0; i < barCount; i++) {
          const val = (freq[i % freq.length] || 0) / 255;
          const barH = val * (h * 0.65);
          const x = i * barWidth;
          const y = (h - barH) / 2;

          const grad = ctx.createLinearGradient(0, y, 0, y + barH);
          grad.addColorStop(0, 'rgba(0, 229, 255, 0.5)');
          grad.addColorStop(1, 'rgba(0, 229, 255, 0.03)');

          ctx.fillStyle = grad;
          ctx.fillRect(x + 2, y, barWidth - 4, barH);
        }

        const timeData = telemetry.timeDomainData;
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = cyan;
        ctx.shadowColor = cyan;
        ctx.shadowBlur = 12;

        const sliceWidth = width / timeData.length;
        let x = 0;

        for (let i = 0; i < timeData.length; i++) {
          const v = timeData[i] / 128.0;
          const y = (v * h) / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

      } else if (voiceState === 'processing') {
        const violet = '#a78bfa';

        const scanX = ((Date.now() / 6) % width);
        const gradScan = ctx.createLinearGradient(scanX - 120, 0, scanX, 0);
        gradScan.addColorStop(0, 'rgba(167, 139, 250, 0)');
        gradScan.addColorStop(1, 'rgba(167, 139, 250, 0.35)');
        ctx.fillStyle = gradScan;
        ctx.fillRect(Math.max(0, scanX - 120), 0, 120, h);

        ctx.strokeStyle = violet;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(scanX, 0);
        ctx.lineTo(scanX, h);
        ctx.stroke();

        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = violet;
        ctx.shadowColor = violet;
        ctx.shadowBlur = 8;

        for (let i = 0; i < width; i += 6) {
          const normalX = (i / width) * Math.PI * 4;
          const y = h / 2 + Math.sin(normalX + time * 2) * 16;
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

      } else if (voiceState === 'speaking') {
        // Deliberately different visual language from "listening": denser,
        // dual-frequency, pulsing envelope with a filled glow body instead
        // of a single thin line — reads as "actively transmitting" rather
        // than "receiving".
        const amber = '#ffb020';
        const points = 120;
        const step = width / points;
        const pulse = 0.75 + Math.sin(time * 3) * 0.25; // slow amplitude breathing

        const topPath: [number, number][] = [];
        const bottomPath: [number, number][] = [];

        for (let i = 0; i <= points; i++) {
          const x = i * step;
          const normalX = (i / points) * Math.PI * 2;
          const wave1 = Math.sin(normalX * 5 + time * 1.6) * 0.42;
          const wave2 = Math.sin(normalX * 11 - time * 2.3) * 0.22;
          const wave3 = Math.sin(normalX * 2.2 + time * 0.8) * 0.18;
          const envelope = Math.sin((i / points) * Math.PI);
          const amplitude = (wave1 + wave2 + wave3) * envelope * pulse * (h * 0.4) * (0.5 + telemetry.rmsVolume * 0.7);
          const y = h / 2 + amplitude;
          topPath.push([x, y]);
        }

        // Filled glow body between the wave and its mirror — gives speaking
        // a fuller, more "broadcasting" silhouette than listening's thin line.
        ctx.beginPath();
        topPath.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        for (let i = topPath.length - 1; i >= 0; i--) {
          const [x, y] = topPath[i];
          const mirroredY = h - y;
          bottomPath.push([x, mirroredY]);
          ctx.lineTo(x, h / 2 + (h / 2 - mirroredY) * 0.18);
        }
        ctx.closePath();
        const bodyGrad = ctx.createLinearGradient(0, 0, 0, h);
        bodyGrad.addColorStop(0, 'rgba(255, 176, 32, 0.16)');
        bodyGrad.addColorStop(0.5, 'rgba(255, 176, 32, 0.05)');
        bodyGrad.addColorStop(1, 'rgba(255, 176, 32, 0.16)');
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        ctx.beginPath();
        topPath.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = amber;
        ctx.shadowColor = amber;
        ctx.shadowBlur = 18;
        ctx.stroke();
        ctx.shadowBlur = 0;

      } else if (voiceState === 'inactivity_countdown') {
        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff5c5c';
        ctx.setLineDash([8, 8]);

        for (let i = 0; i < width; i += 8) {
          const y = h / 2 + (Math.random() - 0.5) * 10;
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

      } else {
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#4a5264';

        for (let i = 0; i < width; i += 8) {
          const noise = (Math.random() - 0.5) * 3;
          const y = h / 2 + noise;
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [voiceState, telemetry, height]);

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.parentElement) {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = height;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [height]);

  return (
    <div className="relative w-full rounded-xl bg-[#090b0f] border border-[#232836] p-2 overflow-hidden shadow-inner">

      {/* Consolidated State Widget */}
      <div className="absolute top-3 left-4 flex items-center gap-2.5 z-10 pointer-events-none select-none">
        <div
          className={`w-3 h-3 rounded-full transition-colors duration-300 ${
            voiceState === 'listening' ? 'bg-[#00e5ff] animate-pulse shadow-[0_0_10px_#00e5ff]' :
            voiceState === 'speaking' ? 'bg-[#ffb020] animate-pulse shadow-[0_0_10px_#ffb020]' :
            voiceState === 'processing' ? 'bg-[#a78bfa] animate-pulse shadow-[0_0_10px_#a78bfa]' :
            voiceState === 'inactivity_countdown' ? 'bg-[#ff5c5c] animate-pulse shadow-[0_0_10px_#ff5c5c]' :
            'bg-[#4b5563]'
          }`}
        />
        <span className={`font-mono text-xs font-bold uppercase tracking-wider transition-colors duration-300 ${
          voiceState === 'listening' ? 'text-[#00e5ff]' :
          voiceState === 'speaking' ? 'text-[#ffb020]' :
          voiceState === 'processing' ? 'text-[#a78bfa]' :
          voiceState === 'inactivity_countdown' ? 'text-[#ff5c5c]' :
          'text-[#8a92a3]'
        }`}>
          {voiceState === 'listening' ? 'LISTENING // MIC ACTIVE' :
           voiceState === 'speaking' ? 'SPEAKING // TRANSMITTING' :
           voiceState === 'processing' ? 'PROCESSING VECTOR SEARCH' :
           voiceState === 'inactivity_countdown' ? `STANDBY IN ${inactivitySecondsLeft}s` :
           'CONSOLE IDLE'}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        height={height}
        className="w-full h-full block rounded-lg"
      />
    </div>
  );
};
