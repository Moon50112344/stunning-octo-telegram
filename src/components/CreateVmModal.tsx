import React, { useState, useEffect, useCallback } from 'react';
import { X, Plus, Cpu, HardDrive, Layers, AlertTriangle, ShieldCheck, RefreshCw, Download, Trash2, CheckCircle2 } from 'lucide-react';
import { OsSelector } from './OsSelector';
import { SupportedOsId, OsDefinition } from '../server/imageManager';

interface ImagePreflightItem {
  osId: SupportedOsId;
  status: string;
  mediaState?: string;
  filePath?: string;
  exists?: boolean;
  sizeBytes?: number;
  expectedSizeBytes?: number;
  progressPercent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  autoDownloadAvailable?: boolean;
  dockurVersion?: string;
  sourceLabel?: string;
  checksumVerified?: boolean;
  checksumStatus?: 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED' | 'MISSING';
  sha256Expected?: string;
  sha256Actual?: string;
  verifiedAt?: string;
  error?: string;
  remediation?: string;
}

interface CreateVmModalProps {
  isOpen: boolean;
  onClose: () => void;
  osList: OsDefinition[];
  initialOs?: SupportedOsId;
  onVmCreated: (vm: any) => void;
}

export function CreateVmModal({ isOpen, onClose, osList, initialOs, onVmCreated }: CreateVmModalProps) {
  const [selectedOs, setSelectedOs] = useState<SupportedOsId>(initialOs || 'debian-12');
  const [vmName, setVmName] = useState<string>('');
  const [cores, setCores] = useState<number>(2);
  const [memoryMb, setMemoryMb] = useState<number>(initialOs === 'windows-10' ? 4096 : initialOs === 'windows-7' ? 1024 : 2048);
  const [diskGb, setDiskGb] = useState<number>(40);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isoActionBusy, setIsoActionBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [imageStatuses, setImageStatuses] = useState<Record<string, ImagePreflightItem>>({});
  const [kvmAvailable, setKvmAvailable] = useState<boolean | null>(null);
  const [hostMemInfo, setHostMemInfo] = useState<{ total: string; available: string } | null>(null);

  const fetchImages = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/images');
      if (!res.ok) return;
      const imgJson = await res.json();
      if (imgJson?.success && Array.isArray(imgJson.images)) {
        const map: Record<string, ImagePreflightItem> = {};
        for (const item of imgJson.images) {
          map[item.osId] = item;
        }
        setImageStatuses(map);
      }
    } catch {
      // ignore
    }
  }, []);

  const applyOsDefaults = (osId: SupportedOsId) => {
    setSelectedOs(osId);
    setError(null);
    const osDef = osList.find((o) => o.id === osId);
    if (osId === 'windows-7') {
      setMemoryMb(1024);
      setDiskGb(Math.max(40, osDef?.minDiskGb || 40));
    } else if (osDef) {
      setMemoryMb(osDef.recommendedRamMb || (osId === 'windows-10' ? 4096 : 2048));
      setDiskGb(Math.max(40, osDef.minDiskGb || 40));
    } else if (osId === 'windows-10') {
      setMemoryMb(4096);
      setDiskGb(40);
    } else {
      setMemoryMb(2048);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    applyOsDefaults(initialOs || 'debian-12');

    fetchImages();
    fetch('/api/v1/infra')
      .then((r) => (r.ok ? r.json() : null))
      .then((infraJson) => {
        if (infraJson?.success && infraJson.report?.virtualization) {
          setKvmAvailable(Boolean(infraJson.report.virtualization.kvmAvailable));
        }
        if (infraJson?.success && infraJson.report?.memory) {
          setHostMemInfo({
            total: infraJson.report.memory.totalFormatted,
            available: infraJson.report.memory.availableFormatted,
          });
        }
      })
      .catch(() => null);
  }, [isOpen, initialOs, fetchImages]);

  const selectedMedia = imageStatuses[selectedOs];
  const isDownloadingOrVerifying =
    selectedMedia?.status === 'DOWNLOADING' || selectedMedia?.status === 'VERIFYING';

  useEffect(() => {
    if (!isOpen || !isDownloadingOrVerifying) return;
    const timer = setInterval(() => {
      void fetchImages();
    }, 1500);
    return () => clearInterval(timer);
  }, [isOpen, isDownloadingOrVerifying, fetchImages]);

  if (!isOpen) return null;

  const handleSelectOs = (osId: SupportedOsId) => {
    applyOsDefaults(osId);
  };

  const handleIsoAction = async (action: 'download' | 'abort' | 'verify' | 'delete') => {
    setIsoActionBusy(true);
    setError(null);
    try {
      const url = action === 'delete' ? `/api/v1/images/${selectedOs}` : `/api/v1/images/${selectedOs}/${action}`;
      const res = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && json.error) {
        setError(json.error);
      }
      await fetchImages();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsoActionBusy(false);
    }
  };

  const isWindowsOs = selectedOs === 'windows-10' || selectedOs === 'windows-7';
  const isMediaBlocked = false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const targetDef = osList.find((o) => o.id === selectedOs);
    const finalName = vmName.trim() || `Cloud VPS (${targetDef?.name || selectedOs})`;

    try {
      const res = await fetch('/api/v1/vms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osId: selectedOs,
          name: finalName,
          cores,
          memoryMb,
          diskGb,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        onVmCreated(json.vm);
        onClose();
      } else {
        throw new Error(json.error || 'Không thể tạo máy ảo mới.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const dlMb = ((selectedMedia?.downloadedBytes || 0) / (1024 * 1024)).toFixed(0);
  const totalMb = ((selectedMedia?.totalBytes || selectedMedia?.expectedSizeBytes || 0) / (1024 * 1024)).toFixed(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0d1424] border border-[#1e2a44] rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#1e2a44] flex items-center justify-between bg-[#0a101d]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-[#2f8bff]/10 border border-[#2f8bff]/30 text-[#2f8bff]">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Tạo máy ảo Cloud VPS mới
              </h2>
              <p className="text-xs text-[#8a99ad]">
                Lựa chọn giữa Debian 12 (Linux), Windows 10 (UEFI) hoặc Windows 7 (Legacy)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8a99ad] hover:text-white hover:bg-[#1e2a44] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          {/* OS Selector */}
          <OsSelector
            selectedOs={selectedOs}
            onSelectOs={handleSelectOs}
            osList={osList}
            disabled={isSubmitting}
          />

          {/* Auto-configured dockurr/windows ISO Engine & Management Panel */}
          {isWindowsOs && (
            <div className="p-3.5 rounded-xl bg-sky-500/10 border border-sky-500/30 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <RefreshCw className={`w-5 h-5 text-sky-400 shrink-0 mt-0.5 ${isDownloadingOrVerifying ? 'animate-spin' : ''}`} />
                  <div className="text-xs text-sky-100/90 leading-relaxed space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sky-300">
                        {selectedMedia?.status === 'READY'
                          ? `Bộ cài đặt ${selectedOs === 'windows-10' ? 'Windows 10' : 'Windows 7'} ISO đã sẵn sàng`
                          : selectedMedia?.status === 'VERIFYING'
                          ? `Đang xác minh mã băm SHA-256 cho ISO...`
                          : selectedMedia?.status === 'DOWNLOADING'
                          ? `Đang tải ISO (${dlMb}/${totalMb} MB — ${selectedMedia.progressPercent || 0}%)`
                          : selectedMedia?.status === 'ERROR'
                          ? `Lỗi tải/xác minh ISO ${selectedOs === 'windows-10' ? 'Windows 10' : 'Windows 7'}`
                          : `Quản lý ISO ${selectedOs === 'windows-10' ? 'Windows 10' : 'Windows 7'} (VERSION=${selectedMedia?.dockurVersion || (selectedOs === 'windows-10' ? '10' : '7u')})`}
                      </span>
                      {selectedMedia?.checksumStatus === 'VERIFIED' && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono text-[10px]">
                          <CheckCircle2 className="w-3 h-3" /> SHA-256 VERIFIED
                        </span>
                      )}
                      {selectedMedia?.checksumStatus === 'MISMATCH' && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40 font-mono text-[10px]">
                          CHECKSUM MISMATCH
                        </span>
                      )}
                    </div>
                    <p className="text-[#c7dcf7]">
                      {selectedMedia?.status === 'READY' && selectedMedia.exists
                        ? `Đã lưu cục bộ (${((selectedMedia.sizeBytes || 0) / (1024 * 1024 * 1024)).toFixed(2)} GiB). Khi tạo VM, hệ thống cũng hỗ trợ stream HTTP-Range NBD để tiết kiệm RAM container.`
                        : 'Hệ thống tự động stream qua NBD (~64 MiB cache) khi khởi tạo VM, hoặc bạn có thể tải sẵn và kiểm tra SHA-256 cục bộ ngay tại đây.'}
                    </p>
                    {selectedMedia?.sha256Expected && (
                      <p className="text-[11px] font-mono text-sky-300/75 truncate max-w-xl" title={selectedMedia.sha256Expected}>
                        SHA-256 chuẩn: {selectedMedia.sha256Expected.slice(0, 24)}...
                      </p>
                    )}
                    {selectedMedia?.error && (
                      <p className="text-red-300 font-mono text-[11px]">
                        {selectedMedia.error} {selectedMedia.remediation ? `— ${selectedMedia.remediation}` : ''}
                      </p>
                    )}
                    {kvmAvailable === false && (
                      <p className="text-amber-300/90">
                        Lưu ý hạ tầng: Máy chủ container không có <code className="font-mono">/dev/kvm</code> (chạy QEMU TCG software emulation{hostMemInfo ? ` • RAM Host: ${hostMemInfo.available} trống / ${hostMemInfo.total}` : ''}).
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Download Progress Bar */}
              {isDownloadingOrVerifying && (
                <div className="space-y-1">
                  <div className="h-2 w-full bg-[#070b14] rounded-full overflow-hidden border border-[#1e2a44]">
                    <div
                      className="h-full bg-[#2f8bff] transition-all duration-300"
                      style={{ width: `${Math.max(2, Math.min(100, selectedMedia?.progressPercent || 0))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-sky-300/80">
                    <span>{selectedMedia?.sourceLabel}</span>
                    <span>{selectedMedia?.progressPercent || 0}%</span>
                  </div>
                </div>
              )}

              {/* ISO Action Buttons */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {isDownloadingOrVerifying ? (
                  <button
                    type="button"
                    disabled={isoActionBusy}
                    onClick={() => handleIsoAction('abort')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Hủy tải ISO
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={isoActionBusy}
                      onClick={() => handleIsoAction('download')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-sky-300 border border-sky-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {selectedMedia?.status === 'ERROR'
                        ? 'Thử tải lại ISO'
                        : selectedMedia?.exists
                        ? 'Tải lại / Cập nhật ISO'
                        : 'Tải & Kiểm tra ISO (SHA-256)'}
                    </button>
                    {selectedMedia?.exists && (
                      <>
                        <button
                          type="button"
                          disabled={isoActionBusy}
                          onClick={() => handleIsoAction('verify')}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-[#1e2a44] text-emerald-300 border border-emerald-500/40 text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Xác minh SHA-256
                        </button>
                        <button
                          type="button"
                          disabled={isoActionBusy}
                          onClick={() => handleIsoAction('delete')}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070b14] hover:bg-red-500/20 text-[#8a99ad] hover:text-red-300 border border-[#1e2a44] text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Xóa ISO cục bộ (Giải phóng RAM)
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Windows 10 UEFI + TPM 2.0 Architecture Info */}
          {selectedOs === 'windows-10' && (
            <div className="p-3 rounded-xl bg-[#2f8bff]/10 border border-[#2f8bff]/30 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-[#2f8bff] shrink-0 mt-0.5" />
              <div className="text-xs text-[#c7dcf7] leading-relaxed">
                <span className="font-semibold text-[#2f8bff] block mb-0.5">
                  Cấu hình Windows 10 Pro (UEFI + TPM 2.0 + AHCI):
                </span>
                Sử dụng máy ảo QEMU Q35, firmware UEFI (OVMF), TPM 2.0 (swtpm), ổ cứng QCOW2 SATA và card mạng Intel e1000e. Yêu cầu file ISO/đĩa Windows 10 hợp lệ trên máy chủ; tài khoản quản trị mặc định có đầy đủ quyền Administrator với UAC tiêu chuẩn.
              </div>
            </div>
          )}

          {/* Windows 7 Security Warning */}
          {selectedOs === 'windows-7' && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200/90 leading-relaxed">
                <span className="font-semibold text-amber-400 block mb-0.5">
                  Lưu ý bảo mật & bộ nhớ Windows 7:
                </span>
                Hệ điều hành Windows 7 đã kết thúc hỗ trợ cập nhật từ Microsoft. Máy ảo được cấu hình chuẩn Legacy PC (i440fx, SeaBIOS, IDE, Intel e1000) và áp dụng giới hạn RAM an toàn chống tràn bộ nhớ (OOM) khi bung file cài đặt.
              </div>
            </div>
          )}

          {/* VM Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#8a99ad] uppercase">
              Tên máy ảo (VM Name)
            </label>
            <input
              type="text"
              placeholder={
                selectedOs === 'windows-10'
                  ? 'Cloud Windows 10 Pro Workstation'
                  : selectedOs === 'windows-7'
                  ? 'Cloud Windows 7 Workstation'
                  : 'Cloud Debian 12 Linux'
              }
              value={vmName}
              onChange={(e) => setVmName(e.target.value)}
              disabled={isSubmitting}
              className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#8a99ad]/40 focus:outline-none focus:border-[#2f8bff]"
            />
          </div>

          {/* Resource Configurations */}
          <div className="grid grid-cols-3 gap-3">
            {/* CPU Cores */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> Cores
              </label>
              <select
                value={cores}
                onChange={(e) => setCores(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1}>1 vCPU</option>
                <option value={2}>2 vCPUs</option>
                <option value={4}>4 vCPUs</option>
              </select>
            </div>

            {/* RAM */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" /> RAM
              </label>
              <select
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={1024}>1 GB (An toàn Win7 Container)</option>
                <option value={2048}>2 GB (Khuyến nghị Debian/Win7)</option>
                <option value={4096}>4 GB (Khuyến nghị Win10)</option>
                <option value={8192}>8 GB (Host &gt;= 16GB)</option>
              </select>
            </div>

            {/* Disk */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#8a99ad] uppercase flex items-center gap-1">
                <HardDrive className="w-3.5 h-3.5" /> Ổ đĩa
              </label>
              <select
                value={diskGb}
                onChange={(e) => setDiskGb(Number(e.target.value))}
                disabled={isSubmitting}
                className="w-full bg-[#070b14] border border-[#1e2a44] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#2f8bff]"
              >
                <option value={20}>20 GB</option>
                <option value={40}>40 GB (Khuyến nghị)</option>
                <option value={80}>80 GB</option>
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-4 border-t border-[#1e2a44] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg border border-[#1e2a44] text-[#8a99ad] hover:text-white text-xs font-medium transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isMediaBlocked}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-[#2f8bff] hover:bg-[#2573d9] text-white text-xs font-semibold shadow-lg shadow-[#2f8bff]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Đang khởi tạo VM...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Tạo máy ảo ngay
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
