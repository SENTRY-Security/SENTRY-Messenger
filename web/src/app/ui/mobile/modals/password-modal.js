// Change password modal

import { t } from '/locales/index.js';

export function createPasswordModal({ deps }) {
  const { log, openModal, closeModal, resetModalVariants, emitMkSetTrace,
    getWrappedMK, setWrappedMK, setMkRaw,
    unwrapMKWithPasswordArgon2id, wrapMKWithPasswordArgon2id,
    getAccountToken, getAccountDigest, getOpaqueServerId,
    mkUpdate, opaqueRegister } = deps;

  async function changePassword(currentPassword, newPassword) {
    const wrapped = getWrappedMK();
    if (!wrapped) {
      const err = new Error(t('password.cannotGetMasterKey'));
      err.userMessage = err.message;
      throw err;
    }
    const mk = await unwrapMKWithPasswordArgon2id(currentPassword, wrapped);
    if (!mk) {
      const err = new Error(t('password.currentPasswordIncorrect'));
      err.userMessage = err.message;
      throw err;
    }
    const newWrapped = await wrapMKWithPasswordArgon2id(newPassword, mk);
    const accountToken = getAccountToken();
    const accountDigest = getAccountDigest();
    const serverId = getOpaqueServerId();
    if (!accountToken || !accountDigest) {
      const err = new Error(t('password.accountInfoInsufficient'));
      err.userMessage = err.message;
      throw err;
    }
    const { r, data } = await mkUpdate({ accountToken, accountDigest, wrapped_mk: newWrapped });
    if (r.status !== 204) {
      const userMessage = typeof data === 'object' && data?.message ? data.message : t('password.updateFailed');
      const err = new Error(userMessage);
      err.userMessage = userMessage;
      throw err;
    }
    try {
      await opaqueRegister({ password: newPassword, accountDigest, serverId });
      log({ changePasswordOpaqueRegister: { ok: true, serverId: !!serverId } });
    } catch (err) {
      const message = err?.message || t('password.updateAuthFailed');
      const error = new Error(message);
      error.userMessage = message;
      throw error;
    }
    log({ changePasswordUpdateStatus: r.status });
    setWrappedMK(newWrapped);
    setMkRaw(mk);
    emitMkSetTrace('app-mobile:change-password', mk);
    log({ passwordChangedAt: Date.now() });
    return true;
  }

  async function open() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    resetModalVariants(modalElement);
    modalElement.classList.add('change-password-modal');
    if (title) title.textContent = t('password.title');
    body.innerHTML = `
      <form id="changePasswordForm" class="change-password-form">
        <label for="currentPassword">
          目前密碼
          <input id="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label for="newPassword">
          新密碼
          <input id="newPassword" type="password" autocomplete="new-password" minlength="6" required />
        </label>
        <label for="confirmPassword">
          確認新密碼
          <input id="confirmPassword" type="password" autocomplete="new-password" minlength="6" required />
        </label>
        <div id="changePasswordStatus" class="change-password-status" role="status" aria-live="polite"></div>
        <div class="change-password-actions">
          <button type="button" class="secondary" id="changePasswordCancel">取消</button>
          <button type="submit" class="primary" id="changePasswordSubmit">${t('password.updatePassword')}</button>
        </div>
      </form>
    `;
    openModal();
    const form = body.querySelector('#changePasswordForm');
    const currentInput = body.querySelector('#currentPassword');
    const newInput = body.querySelector('#newPassword');
    const confirmInput = body.querySelector('#confirmPassword');
    const statusEl = body.querySelector('#changePasswordStatus');
    const cancelBtn = body.querySelector('#changePasswordCancel');
    const submitBtn = body.querySelector('#changePasswordSubmit');

    const setStatus = (text, { success = false } = {}) => {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.toggle('success', !!text && success);
    };
    const setSubmitting = (next) => {
      const disabled = !!next;
      [currentInput, newInput, confirmInput].forEach((input) => { if (input) input.disabled = disabled; });
      if (cancelBtn) cancelBtn.disabled = disabled;
      if (submitBtn) {
        submitBtn.disabled = disabled;
        if (disabled) { submitBtn.dataset.prevText = submitBtn.textContent || t('password.updatePassword'); submitBtn.textContent = t('password.updating'); }
        else if (submitBtn.dataset.prevText) { submitBtn.textContent = submitBtn.dataset.prevText; delete submitBtn.dataset.prevText; }
      }
    };

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const currentPw = currentInput?.value || '';
      const newPw = newInput?.value || '';
      const confirmPw = confirmInput?.value || '';
      setStatus('');
      if (!currentPw) { setStatus(t('password.enterCurrentPassword')); currentInput?.focus(); return; }
      if (!newPw || newPw.length < 6) { setStatus(t('password.newPasswordMinLength')); newInput?.focus(); return; }
      if (newPw === currentPw) { setStatus(t('password.newPasswordMustDiffer')); newInput?.focus(); return; }
      if (newPw !== confirmPw) { setStatus(t('password.passwordMismatch')); confirmInput?.focus(); return; }
      setSubmitting(true);
      try {
        await changePassword(currentPw, newPw);
        setStatus(t('password.passwordUpdated'), { success: true });
        form?.reset();
        setTimeout(() => closeModal(), 1800);
      } catch (err) {
        setStatus(err?.userMessage || err?.message || t('password.updateFailed'));
      } finally {
        setSubmitting(false);
      }
    });
    cancelBtn?.addEventListener('click', (event) => { event.preventDefault(); closeModal(); }, { once: true });
  }

  return { open, changePassword };
}
