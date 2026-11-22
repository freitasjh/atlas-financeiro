import type { Meta, StoryObj } from "@storybook/react-vite"
import { fireEvent, waitFor } from "@testing-library/react"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw message
}
import { MemoryRouter } from "react-router-dom"

import { SignupForm, type SignupResult } from "@/components/auth/SignupForm"

const pending = () => new Promise<SignupResult>(() => {})
const respond = (status: number, retryAfterSeconds: number | null = null) => async (): Promise<SignupResult> => ({
  status,
  retryAfterSeconds,
})

function fill(canvas: HTMLElement) {
  fireEvent.change(canvas.querySelector<HTMLInputElement>("#signup-email")!, {
    target: { value: "pessoa@exemplo.com" },
  })
  fireEvent.change(canvas.querySelector<HTMLInputElement>("#signup-name")!, {
    target: { value: "Maria Silva" },
  })
  fireEvent.change(canvas.querySelector<HTMLInputElement>("#signup-document")!, {
    target: { value: "52998224725" },
  })
  fireEvent.change(canvas.querySelector<HTMLInputElement>("#signup-password")!, {
    target: { value: "senha-segura-1" },
  })
  fireEvent.click(canvas.querySelector<HTMLInputElement>("#signup-accept")!)
}

function send(canvas: HTMLElement) {
  fill(canvas)
  fireEvent.click(canvas.querySelector<HTMLButtonElement>('button[type="submit"]')!)
}

const meta = {
  title: "Auth/SignupForm",
  component: SignupForm,
  parameters: { layout: "centered", a11y: { test: "error" } },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={["/register?plano=full"]}>
        <div className="w-full max-w-sm bg-card p-6 text-foreground">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: { submit: respond(201) },
} satisfies Meta<typeof SignupForm>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: { plano: null },
}

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const cta = canvasElement.querySelector<HTMLButtonElement>('button[type="submit"]')!
    fireEvent.mouseOver(cta)
  },
}

export const Focus: Story = {
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLInputElement>("#signup-email")!.focus()
  },
}

export const Active: Story = {
  play: async ({ canvasElement }) => {
    const cta = canvasElement.querySelector<HTMLButtonElement>('button[type="submit"]')!
    fireEvent.mouseDown(cta)
  },
}

export const Disabled: Story = {
  args: { submit: pending },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() =>
      assert(canvasElement.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "CTA não travou"),
    )
  },
}

export const Loading: Story = {
  args: { submit: pending },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() => assert(canvasElement.querySelector("svg.animate-spin"), "spinner ausente"))
  },
}

export const Error: Story = {
  args: { submit: respond(400) },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() => assert(canvasElement.querySelector('[role="alert"]'), "erro ausente"))
  },
}

export const ErrorRateLimited: Story = {
  args: { submit: respond(429, 30) },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() => assert(canvasElement.querySelector('[role="alert"]')?.textContent?.includes("30"), "segundos ausentes"))
  },
}

export const ErrorFailure: Story = {
  args: { submit: respond(500) },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() => assert(canvasElement.querySelector('[role="alert"]'), "erro ausente"))
  },
}

export const Success: Story = {
  args: { submit: respond(201) },
  play: async ({ canvasElement }) => {
    send(canvasElement)
    await waitFor(() => assert(canvasElement.querySelector('[role="status"]'), "sucesso ausente"))
  },
}
