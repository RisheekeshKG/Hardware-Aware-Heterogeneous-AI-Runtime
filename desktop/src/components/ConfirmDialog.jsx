import { Button } from './Button.jsx'
import { Modal, ModalActions } from './Modal.jsx'

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'danger', onAnswer }) {
  return <Modal role="alertdialog" eyebrow="PLEASE CONFIRM" title={title} onClose={() => onAnswer(false)} className="confirm-modal">
    {message && <p>{message}</p>}
    <ModalActions>
      <Button onClick={() => onAnswer(false)}>Cancel</Button>
      <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>{confirmLabel}</Button>
    </ModalActions>
  </Modal>
}
