import { ConnectionBar } from './components/ConnectionBar'
import { PreviewPane } from './components/PreviewPane'
import { PromptBar } from './components/PromptBar'
import { SettingsPanel } from './components/SettingsPanel'
import { StatsHud } from './components/StatsHud'
import { useJoyAISession } from './state/useSession'

export default function App() {
  const session = useJoyAISession()

  return (
    <div className="app">
      <ConnectionBar session={session} />
      <main className="layout">
        <div className="stage">
          <PreviewPane session={session} />
          <PromptBar session={session} />
          <StatsHud session={session} />
        </div>
        <SettingsPanel session={session} />
      </main>
    </div>
  )
}
