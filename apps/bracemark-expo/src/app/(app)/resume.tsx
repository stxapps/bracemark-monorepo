import { ResumeScreen } from '../../features/auth/resume-screen';

// `/resume` — "Sign in to resume" for an expired session (docs/sessions.md),
// presented as a modal over the app Stack (declared in this group's _layout). It
// lives in the SIGNED-IN group on purpose: an expired session is still signed in —
// the library stays open underneath — so the guest-only `/sign-in` route would
// bounce it. Thin by convention — the UI is in src/features/auth/.
export default function ResumeRoute() {
  return <ResumeScreen />;
}
