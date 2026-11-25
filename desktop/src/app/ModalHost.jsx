import { Launcher } from '../views/benchmarks/Launcher.jsx'
import { ConnectDevice } from '../views/devices/ConnectDevice.jsx'
import { ScriptLauncher } from '../views/scripts/ScriptLauncher.jsx'
import { useNavigation } from './NavigationProvider.jsx'

const modals = { benchmark: Launcher, script: ScriptLauncher, connect: ConnectDevice }

export function ModalHost() {
  const { modal, closeModal } = useNavigation()
  const Modal = modals[modal]
  return Modal ? <Modal onClose={closeModal} /> : null
}
