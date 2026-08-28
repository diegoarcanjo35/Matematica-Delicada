import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("renders an accessible progressbar with the correct value", () => {
    render(<ProgressBar label="Domínio atual" value={42} />);
    const bar = screen.getByRole("progressbar", { name: "Domínio atual" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("clamps values above the max to 100%", () => {
    render(<ProgressBar label="Reconhecimento" value={150} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
