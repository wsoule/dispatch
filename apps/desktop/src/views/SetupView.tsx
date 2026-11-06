import { type ReactNode, useCallback, useState } from 'react';

import { GitStep } from '../components/setup/GitStep';
import { ProjectStep } from '../components/setup/ProjectStep';
import { SetupStepRow } from '../components/setup/SetupStepRow';
import styles from './SetupView.module.css';

interface SetupViewProps {
  /** The open folder when it isn't set up yet; null on a first launch with no project. */
  projectPath: string | null;
  onProjectChosen: (path: string) => Promise<void>;
  /** The agent step, rendered by App once a project (and its daemon) exists. */
  agentStep?: ReactNode;
  /** The optional Linear step, beside the agent step once the daemon exists. */
  linearStep?: ReactNode;
}

/**
 * First-launch setup: Git, then your project, then your AI agent, and Linear if you
 * plan with it. Everything a new user needs before their first task, each with its
 * own fix button. App draws the
 * signed-out frame (and its one <main>) around it, so this is only the centred column.
 */
export function SetupView({
  projectPath,
  onProjectChosen,
  agentStep,
  linearStep,
}: SetupViewProps) {
  const [gitReady, setGitReady] = useState(false);
  const onGitReady = useCallback((ready: boolean) => setGitReady(ready), []);
  return (
    <div className={styles.column}>
      <div className={styles.intro}>
        <h1 className={styles.title}>Welcome to Dispatch</h1>
        <p className={styles.lede}>
          A few things and you're ready to hand work to an AI agent.
        </p>
      </div>
      <div className={styles.steps}>
        <GitStep onReady={onGitReady} />
        {agentStep === undefined ? (
          <>
            <ProjectStep
              enabled={gitReady}
              projectPath={projectPath}
              onProjectChosen={onProjectChosen}
            />
            <SetupStepRow
              status="waiting"
              title="Your AI agent"
              message="Then: choose the AI agent that does the work."
            />
          </>
        ) : (
          <>
            <SetupStepRow
              status="ok"
              title="Your project"
              message="Your project is ready."
            />
            {agentStep}
            {linearStep}
          </>
        )}
      </div>
    </div>
  );
}
