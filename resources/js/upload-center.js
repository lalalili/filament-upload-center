import Uppy from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import GoldenRetriever from '@uppy/golden-retriever';
import '../css/upload-center.css';

const text = (value) => document.createTextNode(String(value ?? ''));

const formatBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const fingerprint = (file) => `${file.name}:${file.size}:${file.data?.lastModified ?? ''}`;

/**
 * Adapter methods: createSession, restoreSession, directParameters,
 * createMultipart, signPart, complete, cancel, poll. All return host-normalized DTOs.
 */
export function createUploadCenter(root, options) {
  if (!root || root.__filamentUploadCenter) return root?.__filamentUploadCenter;

  const adapter = options.adapter;
  const state = {
    sessions: new Map(),
    sessionPromises: new Map(),
    startedAt: new Map(),
    active: new Set(),
  };
  const input = root.querySelector('[data-upload-input]');
  const dropzone = root.querySelector('[data-upload-dropzone]');
  const list = root.querySelector('[data-upload-list]');
  const count = root.querySelector('[data-upload-count]');
  const notifications = root.querySelector('[data-upload-notifications]');

  const renderNotifications = () => {
    if (!notifications) return;
    const info = uppy.getState().info.at(-1);
    notifications.hidden = !info;
    notifications.dataset.type = info?.type ?? 'info';
    const details = info?.details && info.details !== info.message ? `\n原因：${info.details}` : '';
    notifications.replaceChildren(info ? text(`${info.message}${details}`) : text(''));
  };

  const render = () => {
    if (!list) return;
    list.replaceChildren();
    const sessions = [...state.sessions.values()];
    count?.replaceChildren(
      text(
        sessions.filter((session) => !['completed', 'cancelled', 'failed'].includes(session.status))
          .length,
      ),
    );

    sessions.forEach((session) => {
      const row = document.createElement('article');
      row.className = 'fuc-row';
      row.dataset.sessionId = session.id;
      const main = document.createElement('div');
      main.className = 'fuc-row-main';
      const title = document.createElement('strong');
      title.textContent = session.name;
      const detail = document.createElement('span');
      const total = Number(session.size || 0);
      const uploaded = Number(session.bytesUploaded || 0);
      const percent = total ? Math.min(100, Math.round((uploaded / total) * 100)) : 0;
      detail.textContent = `${statusLabel(session.status)} · ${formatBytes(uploaded)} / ${formatBytes(total)} · ${percent}%`;
      const progress = document.createElement('div');
      progress.className = 'fuc-progress';
      const bar = document.createElement('span');
      bar.style.width = `${['completed', 'processing'].includes(session.status) ? 100 : percent}%`;
      progress.append(bar);
      main.append(title, detail, progress);
      const actions = document.createElement('div');
      actions.className = 'fuc-row-actions';
      if (['uploading', 'queued'].includes(session.status))
        actions.append(actionButton('暫停', 'pause'));
      if (session.status === 'pausing') actions.append(actionButton('暫停中…', 'pause', true));
      if (session.status === 'paused') actions.append(actionButton('繼續', 'resume'));
      if (session.status === 'resuming') actions.append(actionButton('繼續中…', 'resume', true));
      if (['failed', 'expired'].includes(session.status))
        actions.append(actionButton('重試', 'retry'));
      if (session.status === 'cancelling') actions.append(actionButton('取消中…', 'cancel', true));
      else if (!['completed', 'cancelled'].includes(session.status))
        actions.append(actionButton('取消', 'cancel'));
      row.append(main, actions);
      list.append(row);
    });
  };

  const actionButton = (label, action, processing = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fuc-action';
    button.dataset.uploadAction = action;
    if (processing) {
      button.dataset.processing = 'true';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    button.textContent = label;
    return button;
  };

  const isInactiveUploadSessionError = (error) =>
    error?.inactiveUploadSession === true ||
    (error?.source?.status === 422 && /upload session|上傳工作/i.test(error.message ?? ''));

  const invalidateUploadFile = (file, error) => {
    const session = file.meta?.uploadSession;
    if (!session) return;

    state.sessions.set(session.id, {
      ...state.sessions.get(session.id),
      status: 'expired',
      error: error.message,
    });
    state.active.delete(session.id);
    if (uppy.getFile(file.id)) uppy.removeFile(file.id);
    uppy.info('先前的上傳工作已失效，請重新選擇檔案。', 'warning', 5000);
    render();
  };

  const stopUnprocessableUpload = (file, error) => {
    const session = file.meta?.uploadSession;
    if (!session) return;

    if (!file.isPaused && uppy.getFile(file.id)) uppy.pauseResume(file.id);
    state.sessions.set(session.id, {
      ...state.sessions.get(session.id),
      status: 'failed',
      error: error.message,
    });
    state.active.delete(session.id);
    uppy.info(error.message || '上傳資料驗證失敗，請重新確認。', 'error', 8000);
    render();
  };

  const ensureSession = async (file) => {
    const existing = file.meta?.uploadSession;
    if (existing) return existing;

    const pending = state.sessionPromises.get(file.id);
    if (pending) return pending;

    const promise = (async () => {
      const created = await adapter.createSession(file, options.context());
      const session = {
        ...created.session,
        id: created.session.id,
        name: file.name,
        size: file.size,
        bytesUploaded: 0,
        status: 'queued',
        upload: created.upload,
      };
      uppy.setFileMeta(file.id, { uploadSession: session, fingerprint: fingerprint(file) });
      state.sessions.set(session.id, session);
      render();
      return session;
    })();

    state.sessionPromises.set(file.id, promise);

    try {
      return await promise;
    } finally {
      if (state.sessionPromises.get(file.id) === promise) state.sessionPromises.delete(file.id);
    }
  };

  const uppy = new Uppy({
    id: options.id,
    autoProceed: true,
    allowMultipleUploadBatches: true,
    restrictions: {
      allowedFileTypes: options.allowedFileTypes,
      ...(options.maxNumberOfFiles ? { maxNumberOfFiles: options.maxNumberOfFiles } : {}),
    },
  })
    .use(GoldenRetriever, {
      serviceWorker: Boolean(options.serviceWorker),
      expires: 24 * 60 * 60 * 1000,
    })
    .use(AwsS3, {
      shouldUseMultipart: (file) => adapter.shouldUseMultipart(file),
      limit: 1,
      retryDelays: [1000, 3000, 10000, 30000],
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

        if (['cancelled', 'expired', 'failed'].includes(restored.status)) {
          throw Object.assign(new Error('此上傳工作已失效，請重新選擇檔案。'), {
            inactiveUploadSession: true,
            source: { status: 422 },
          });
        }

        state.sessions.set(session.id, { ...state.sessions.get(session.id), ...restored });
        return (restored.uploadedParts ?? []).map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          Size: part.size,
        }));
      },
      signPart: async (file, part) => {
        const session = await ensureSession(file);
        try {
          return await adapter.signPart(session, part.partNumber, file);
        } catch (error) {
          if (isInactiveUploadSessionError(error)) {
            error.inactiveUploadSession = true;
            invalidateUploadFile(file, error);
          } else if (error?.source?.status === 422) {
            stopUnprocessableUpload(file, error);
          }

          throw error;
        }
      },
      completeMultipartUpload: async (file, data) => {
        const session = await ensureSession(file);
        await adapter.complete(
          session,
          data.parts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })),
          file,
        );
        return { location: null };
      },
      // Uppy invokes this callback for transport errors as well as deliberate cancellation.
      // Deliberate cancellation is handled by the UI action below; preserving the session here
      // allows a temporary error or a page refresh to resume the existing multipart upload.
      abortMultipartUpload: async () => {},
    });

  uppy.on('file-added', (file) => {
    if (!file.data) return;
    void ensureSession(file).catch((error) => {
      if (uppy.getFile(file.id) && !file.meta?.uploadSession) uppy.removeFile(file.id);
      uppy.info(error.message || '無法建立上傳工作', 'error', 5000);
    });
  });
  uppy.on('info-visible', renderNotifications);
  uppy.on('info-hidden', renderNotifications);
  uppy.on('upload-progress', (file, progress) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    const currentFile = uppy.getFile(file.id);
    const isPaused = currentFile?.isPaused ?? file.isPaused;
    const currentSession = state.sessions.get(session.id);
    const preserveStatus = ['pausing', 'cancelling', 'cancelled'].includes(currentSession?.status);
    const startedAt = state.startedAt.get(session.id) ?? Date.now();
    state.startedAt.set(session.id, startedAt);
    if (isPaused || preserveStatus) state.active.delete(session.id);
    else state.active.add(session.id);
    state.sessions.set(session.id, {
      ...currentSession,
      status: preserveStatus ? currentSession.status : isPaused ? 'paused' : 'uploading',
      bytesUploaded: progress.bytesUploaded,
    });
    render();
  });
  uppy.on('upload-pause', (file, isPaused) => {
    const session = file?.meta?.uploadSession;
    if (!session) return;

    if (isPaused) state.active.delete(session.id);
    else state.active.add(session.id);
    state.sessions.set(session.id, {
      ...state.sessions.get(session.id),
      status: isPaused ? 'paused' : 'uploading',
    });
    render();
  });
  uppy.on('upload-success', async (file) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    if (['cancelling', 'cancelled'].includes(state.sessions.get(session.id)?.status)) return;
    if (!adapter.shouldUseMultipart(file)) await adapter.complete(session, [], file);
    state.sessions.set(session.id, {
      ...state.sessions.get(session.id),
      status: 'processing',
      bytesUploaded: file.size,
    });
    state.active.delete(session.id);
    render();
  });
  uppy.on('upload-error', (file, error) => {
    const session = file.meta?.uploadSession;
    if (!session) return;
    if (['cancelling', 'cancelled'].includes(state.sessions.get(session.id)?.status)) return;

    if (isInactiveUploadSessionError(error)) {
      invalidateUploadFile(file, error);
      return;
    }

    state.sessions.set(session.id, {
      ...state.sessions.get(session.id),
      status: 'failed',
      error: error.message,
    });
    state.active.delete(session.id);
    render();
  });
  uppy.on('restore-confirmed', () => {
    uppy.getFiles().forEach((file) => {
      const session = file.meta?.uploadSession;
      if (session?.id)
        state.sessions.set(session.id, {
          ...session,
          name: file.name,
          size: file.size,
          status: session.status ?? 'paused',
        });
    });
    render();
  });

  const addFiles = (files) => {
    const knownFiles = new Map(uppy.getFiles().map((file) => [`${file.name}:${file.size}`, file]));

    [...files].forEach((file) => {
      let resumeSession = null;

      try {
        resumeSession = options.resumeSession?.(file) ?? null;
      } catch (error) {
        uppy.info(
          error instanceof Error ? error.message : '無法續傳此檔案，請重新確認。',
          'error',
          5000,
        );
        return;
      }

      const comparableFingerprint = `${file.name}:${file.size}`;
      const existing = knownFiles.get(comparableFingerprint);

      if (existing) {
        const session = existing.meta?.uploadSession;
        const sessionStatus = session
          ? (state.sessions.get(session.id)?.status ?? session.status)
          : null;
        const replaceable =
          existing.isGhost ||
          !existing.data ||
          Boolean(existing.error) ||
          !session ||
          ['failed', 'cancelled', 'expired'].includes(sessionStatus);

        if (replaceable) {
          uppy.removeFile(existing.id);
          if (session) {
            state.sessions.delete(session.id);
            state.startedAt.delete(session.id);
            state.active.delete(session.id);
          }
          knownFiles.delete(comparableFingerprint);
          render();
        } else {
          uppy.info(`已略過重複檔案：${file.name}`, 'info', 3000);
          return;
        }
      }

      try {
        const fileId = uppy.addFile({
          name: file.name,
          type: file.type,
          data: file,
          meta: resumeSession
            ? { uploadSession: resumeSession, fingerprint: fingerprint(file) }
            : undefined,
        });

        if (resumeSession) {
          const session = {
            ...resumeSession,
            name: file.name,
            size: file.size,
            status: resumeSession.status ?? 'queued',
          };
          state.sessions.set(session.id, session);
          uppy.setFileMeta(fileId, { uploadSession: session, fingerprint: fingerprint(file) });
          uppy.setFileState(fileId, {
            s3Multipart: { uploadId: session.id, key: session.id },
          });
          render();
        }

        knownFiles.set(comparableFingerprint, uppy.getFile(fileId));
      } catch (error) {
        if (error instanceof Error && error.message.includes('duplicate file')) {
          uppy.info(`已略過重複檔案：${file.name}`, 'info', 3000);
          return;
        }

        throw error;
      }
    });
  };

  input?.addEventListener('change', (event) => {
    addFiles(event.target.files ?? []);
    event.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((eventName) =>
    dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.dataset.dragging = 'true';
    }),
  );
  ['dragleave', 'drop'].forEach((eventName) =>
    dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      delete dropzone.dataset.dragging;
    }),
  );
  dropzone?.addEventListener('drop', (event) => addFiles(event.dataTransfer?.files ?? []));
  list?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-upload-action]');
    const id = button?.closest('[data-session-id]')?.dataset.sessionId;
    const session = id ? state.sessions.get(id) : null;
    if (!button || button.disabled || !session) return;
    const file = uppy.getFiles().find((file) => file.meta?.uploadSession?.id === session.id);
    const action = button.dataset.uploadAction;

    if (action === 'pause' && file && !file.isPaused) {
      state.sessions.set(session.id, { ...session, status: 'pausing' });
      state.active.delete(session.id);
      render();
      uppy.pauseResume(file.id);
      return;
    }

    if (action === 'resume' && file?.isPaused) {
      state.sessions.set(session.id, { ...session, status: 'resuming' });
      render();
      uppy.pauseResume(file.id);
      return;
    }

    if (action === 'cancel') {
      if (file && !file.isPaused) uppy.pauseResume(file.id);
      state.sessions.set(session.id, { ...state.sessions.get(session.id), status: 'cancelling' });
      state.active.delete(session.id);
      render();

      try {
        await adapter.cancel(session);
        state.sessions.set(session.id, { ...state.sessions.get(session.id), status: 'cancelled' });
      } catch (error) {
        const currentFile = file ? uppy.getFile(file.id) : null;
        const message = error instanceof Error ? error.message : '取消上傳失敗，請稍後再試。';
        state.sessions.set(session.id, {
          ...state.sessions.get(session.id),
          status: currentFile?.isPaused ? 'paused' : 'failed',
          error: message,
        });
        uppy.info(message, 'error', 5000);
      }

      render();
      return;
    }

    if (action === 'retry' && file) await uppy.retryUpload(file.id);
  });

  const poll = async () => {
    for (const session of state.sessions.values()) {
      if (!['processing', 'uploading'].includes(session.status)) continue;
      const fresh = await adapter.poll(session);
      state.sessions.set(session.id, { ...session, ...fresh });
    }
    render();
  };
  const timer = window.setInterval(() => void poll().catch(() => {}), 5000);
  root.__filamentUploadCenter = {
    uppy,
    destroy: () => {
      window.clearInterval(timer);
      uppy.close();
    },
  };
  render();
  return root.__filamentUploadCenter;
}

function statusLabel(status) {
  return (
    {
      queued: '等待上傳',
      uploading: '上傳中',
      pausing: '暫停中',
      paused: '已暫停',
      resuming: '繼續中',
      cancelling: '取消中',
      processing: '正在處理逐字稿',
      completed: '已完成',
      failed: '上傳失敗',
      cancelled: '已取消',
      expired: '上傳已到期',
    }[status] ?? status
  );
}
