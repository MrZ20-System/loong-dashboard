import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { translate } from "../../i18n";
import { CRON_HELP_MESSAGE, CronField } from "./CronField";

describe("CronField", () => {
  it("explains the five fields and step syntax instead of listing examples", () => {
    render(
      <CronField
        label="Checkpoint Cron"
        value="0 0 * * *"
        defaultValue="0 0 * * *"
        onChange={() => undefined}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Checkpoint Cron" });
    const help = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(help).toHaveTextContent("minute, hour, day of month, month, and day of week");
    expect(help).toHaveTextContent("*/30 means every 30 units");
    expect(translate("zh-CN", CRON_HELP_MESSAGE)).toContain("分钟、小时、日、月、星期");
    expect(translate("zh-CN", CRON_HELP_MESSAGE)).toContain("*/30 表示每 30 个单位执行一次");
  });
});
