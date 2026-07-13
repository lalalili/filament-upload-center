import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import GoldenRetriever from "@uppy/golden-retriever";
import "../css/upload-center.css";

const text = (value) => document.createTextNode(String(value ?? ""));

const formatBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const fingerprint = (file) => `${file.name}:${file.size}:${file.data?.lastModified ?? ""}`;

/**
 * Adapter methods: createSession, restoreSession, directParameters,
 * createMultipart, signPart, complete, cancel, poll. All return host-normalized DTOs.
 */
export function createUploadCenter(root, options) {
  if (!root || root.__filamentUploadCenter) return root?.__filamentUploadCenter;

  const adapter = options.adapter;
  const state = { sessions: new Map(), startedAt: new Map(), active: new Set() };
  const input = root.querySelector("[data-upload-input]");
  const dropzone = root.querySelector("[data-upload-dropzone]");
  const list = root.querySelector("[data-upload-list]");
  const count = root.querySelector("[data-upload-count]");

  const render = () => {
    if (!list) return;
    list.replaceChildren();
    const sessions = [...state.sessions.values()];
    count?.replaceChildren(text(sessions.filter((session) => !["completed", "cancelled", "failed"].includes(session.status)).length));

    sessions.forEach((session) => {
      const row = document.createElement("article");
      row.className = "fuc-row";
      row.dataset.sessionId = session.id;
      const main = document.createElement("div");
      main.className = "fuc-row-main";
      const title = document.createElement("strong");
      title.textContent = session.name;
      const detail = document.createElement("span");
      const total = Number(session.size || 0);
      const uploaded = Number(session.bytesUploaded || 0);
      const percent = total ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;
      detail.textContent = `${statusLabel(session.status)} · ${formatBytes(uploaded)} / ${formatBytes(total)} · ${percent}%`;
      const progress = document.createElement("div");
      progress.className = "fuc-progress";
      const bar = document.createElement("span");
      bar.style.width = `${["completed", "processing"].includes(session.status) ? 100 : percent}%`;
      progress.append(bar);
      main.append(title, detail, progress);
      const actions = document.createElement("div");
      actions.className = "fuc-row-actions";
      if (["uploading", "queued"].includes(session.status)) actions.append(actionButton("暫停", "pause"));
      if (session.status === "paused") actions.append(actionButton("繼續", "resume"));
      if (["failed", "expired"].includes(session.status)) actions.append(actionButton("重試", "retry"));
      if (!["completed", "cancelled"].includes(session.status)) actions.append(actionButton("取消", "cancel"));
      row.append(main, actions);
      list.append(row);
    });
  };

  const actionButton = (label, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fuc-action";
    button.dataset.uploadAction = action;
    button.textContent = label;
    return button;
  };

  const ensureSession = async (file) => {
    const existing = file.meta?.uploadSession;
    if (existing) return existing;
    const created = await adapter.createSession(file, options.context());
    const session = { ...created.session, id: created.session.id, name: file.name, size: file.size, bytesUploaded: 0, status: "queued", upload: created.upload };
    uppy.setFileMeta(file.id, { uploadSession: session, fingerprint: fingerprint(file) });
    state.sessions.set(session.id, session);
    render();
    return session;
  };

  const uppy = new Uppy({
    id: options.id,
    autoProceed: true,
    allowMultipleUploadBatches: true,
    restrictions: { allowedFileTypes: options.allowedFileTypes },
  })
    .use(GoldenRetriever, { serviceWorker: Boolean(options.serviceWorker), expires: 24 * 60 * 60 * 1000 })
    .use(AwsS3, {
      shouldUseMultipart: (file) => adapter.shouldUseMultipart(file),
      limit: 1,
      getUploadParameters: async (file) => {
        const session = await ensureSession(file);
        return adapter.directParameters(session, file);
      },
      createMultipartUpload: async (file) => {
        const session = await ensureSession(file);
        await adapter.createMultipart(session, file);
        return { uploadId: session.id, key: session.id };
      },
      listParts: async (file) => {
        const session = await ensureSession(file);
        const restored = await adapter.restoreSession(session, file);
        state.sessions.set(session.id, { ...state.sessions.get(session.id), ...restored });
        return (restored.uploadedParts ?? []).map((part) => ({ PartNumber: part.partNumber, ETag: part.etag, Size: part.size }));
      },
      signPart: async (file, part) => {
        const session = await ensureSession(file);
        return adapter.signPart(session, part.partNumber, file);
      },
      completeMultipartUpload: async (file, data) => {
        const session = await ensureSession(file);
        await adapter.complete(session, data.parts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })), file);
        return { location: null };
      },
      abortMultipartUpload: async (file) => {
        const session = file.meta?.uploadSession;
        if (session) await adapter.cancel(session);
      },
    });

  uppy.on("file-added", (file) => {
    if (!file.data) return;
    void ensureSession(file).catch((error) => {
      uppy.info(error.message || "無法建立上傳工作", "error", 5000);
    });
  });
  uppy.on("upload-progress", (file, progress) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    const startedAt = state.startedAt.get(session.id) ?? Date.now();
    state.startedAt.set(session.id, startedAt);
    state.active.add(session.id);
    state.sessions.set(session.id, { ...state.sessions.get(session.id), status: "uploading", bytesUploaded: progress.bytesUploaded });
    render();
  });
  uppy.on("upload-success", async (file) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    if (!adapter.shouldUseMultipart(file)) await adapter.complete(session, [], file);
    state.sessions.set(session.id, { ...state.sessions.get(session.id), status: "processing", bytesUploaded: file.size });
    state.active.delete(session.id);
    render();
  });
  uppy.on("upload-error", (file, error) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    state.sessions.set(session.id, { ...state.sessions.get(session.id), status: "failed", error: error.message });
    state.active.delete(session.id);
    render();
  });
  uppy.on("restore-confirmed", () => {
    uppy.getFiles().forEach((file) => {
      const session = file.meta?.uploadSession;
      if (session?.id) state.sessions.set(session.id, { ...session, name: file.name, size: file.size, status: session.status ?? "paused" });
    });
    render();
  });

  input?.addEventListener("change", (event) => {
    [...(event.target.files ?? [])].forEach((file) => uppy.addFile({ name: file.name, type: file.type, data: file }));
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => dropzone?.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.dataset.dragging = "true"; }));
  ["dragleave", "drop"].forEach((eventName) => dropzone?.addEventListener(eventName, (event) => { event.preventDefault(); delete dropzone.dataset.dragging; }));
  dropzone?.addEventListener("drop", (event) => [...(event.dataTransfer?.files ?? [])].forEach((file) => uppy.addFile({ name: file.name, type: file.type, data: file })));
  list?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-upload-action]");
    const id = button?.closest("[data-session-id]")?.dataset.sessionId;
    const session = id ? state.sessions.get(id) : null;
    if (!button || !session) return;
    if (button.dataset.uploadAction === "cancel") await adapter.cancel(session);
    if (button.dataset.uploadAction === "pause") uppy.pauseAll();
    if (button.dataset.uploadAction === "resume") uppy.resumeAll();
    if (button.dataset.uploadAction === "retry") uppy.retryAll();
    state.sessions.set(session.id, { ...session, status: button.dataset.uploadAction === "cancel" ? "cancelled" : session.status });
    render();
  });

  const poll = async () => {
    for (const session of state.sessions.values()) {
      if (!["processing", "uploading"].includes(session.status)) continue;
      const fresh = await adapter.poll(session);
      state.sessions.set(session.id, { ...session, ...fresh });
    }
    render();
  };
  const timer = window.setInterval(() => void poll().catch(() => {}), 5000);
  root.__filamentUploadCenter = { uppy, destroy: () => { window.clearInterval(timer); uppy.close(); } };
  render();
  return root.__filamentUploadCenter;
}

function statusLabel(status) {
  return ({ queued: "等待上傳", uploading: "上傳中", paused: "已暫停", processing: "正在處理逐字稿", completed: "已完成", failed: "上傳失敗", cancelled: "已取消", expired: "上傳已到期" })[status] ?? status;
}
