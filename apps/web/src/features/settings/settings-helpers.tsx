export function ErrorText({ error }: { error: unknown }) {
  return (
    <p role="alert" className="settings-error">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
