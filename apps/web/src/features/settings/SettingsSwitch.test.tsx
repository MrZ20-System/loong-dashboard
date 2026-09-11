import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { SettingsSwitch } from "./SettingsSwitch";

function SettingsBooleanDraftHarness() {
  const [draft, setDraft] = useState({
    automaticSync: false,
    autoCommit: false,
    automaticCheckpoint: false,
    archiveEnabled: false,
  });
  const [submitted, setSubmitted] = useState<typeof draft | null>(null);
  return (
    <form onSubmit={(event) => { event.preventDefault(); setSubmitted(draft); }}>
      <SettingsSwitch label="Automatic sync" checked={draft.automaticSync} onChange={(checked) => setDraft((old) => ({ ...old, automaticSync: checked }))} />
      <SettingsSwitch label="Automatic commit" checked={draft.autoCommit} onChange={(checked) => setDraft((old) => ({ ...old, autoCommit: checked }))} />
      <SettingsSwitch label="Automatic checkpoint" checked={draft.automaticCheckpoint} onChange={(checked) => setDraft((old) => ({ ...old, automaticCheckpoint: checked }))} />
      <SettingsSwitch label="Automatic export" checked={draft.archiveEnabled} onChange={(checked) => setDraft((old) => ({ ...old, archiveEnabled: checked }))} />
      <button type="submit">Save</button>
      {submitted !== null && <output data-testid="submitted">{JSON.stringify(submitted)}</output>}
    </form>
  );
}

describe("SettingsSwitch", () => {
  it("uses the same accessible switch and submits boolean draft values for repository, checkpoint, backup, and archive settings", () => {
    render(<SettingsBooleanDraftHarness />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const control of switches) fireEvent.click(control);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByTestId("submitted").textContent).toBe(JSON.stringify({
      automaticSync: true,
      autoCommit: true,
      automaticCheckpoint: true,
      archiveEnabled: true,
    }));
  });

  it("keeps a keyboard-focusable switch track and disabled state", () => {
    render(<SettingsSwitch label="Automatic push" checked={false} disabled onChange={() => undefined} />);
    const control = screen.getByRole("switch", { name: "Automatic push" });
    expect(control).toBeDisabled();
    expect(control.parentElement?.querySelector(".settings-switch__track")).not.toBeNull();
  });
});
