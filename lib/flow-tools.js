/**
 * Flow tools: how a flow starts.
 *
 * The agent starts a flow by calling a tool, the same way it starts a goal with
 * `create_goal` or writes a plan with `todo_write`. The user says what they
 * want in words; the agent turns that into the call. There is no other channel:
 * a plugin that parsed the user's text directly would be making a judgement
 * about intent, which is exactly what this design is trying to stop doing in
 * code.
 *
 * Only `start_flow` is offered to the agent. Pause, resume and cancel belong to
 * the user, who drives them from the panel — an agent that could park its own
 * pipeline could also quietly skip its self-check.
 */

/**
 * Build the tool definition for one workspace.
 *
 * @param {object} options
 * @param {string[]} options.flowNames the flows this workspace defines
 * @param {(name: string) => string} options.labelFor localized flow label
 * @param {(name: string, agent: object, note: string) => Promise<object>} options.start starts the flow
 * @returns {object} a ToolDefinition for ctx.tools.register
 */
export function startFlowTool({ flowNames, labelFor, start }) {
  return {
    name: "start_flow",
    description:
      "Start one of this workspace's fixed review pipelines. Use it when the user asks for a "
      + "requirement, reports a bug, or asks about a rebase conflict. The pipeline then advances on "
      + "its own and pauses where the user has to decide; it does not need starting again.",
    parameters: {
      type: "object",
      properties: {
        flow: {
          type: "string",
          enum: flowNames,
          description: `Which pipeline: ${flowNames.map((n) => `${n} (${labelFor(n)})`).join(", ")}.`,
        },
        note: {
          type: "string",
          description: "One line on what the user asked for, shown in the panel.",
        },
      },
      required: ["flow"],
    },
    async execute({ flow, note }, exec) {
      if (!flowNames.includes(flow)) {
        // The enum already restricts this, but a model can still send anything.
        return {
          content: [{
            type: "text",
            text: `Unknown flow "${flow}". Available: ${flowNames.join(", ")}.`,
          }],
          isError: true,
        }
      }
      // The agent that called this tool is the one whose session the flow
      // belongs to; the executor supplies it and nothing else can.
      const state = await start(flow, exec?.agent, note)
      if (!state) {
        return { content: [{ type: "text", text: `Could not start the ${flow} flow.` }], isError: true }
      }
      return {
        content: [{
          type: "text",
          text: `Started the ${labelFor(flow)} flow (${state.steps.length} steps). `
            + "It advances by itself and pauses where you have to decide.",
        }],
      }
    },
  }
}

/**
 * Register the flow tools on a context.
 *
 * @param {object} ctx plugin context
 * @param {object} deps same options startFlowTool takes
 * @returns {() => void} disposer for every registration
 */
export function registerFlowTools(ctx, deps) {
  if (deps.flowNames.length === 0) return () => {}
  let dispose
  try {
    dispose = ctx.tools.register(startFlowTool(deps))
  } catch {
    // A profile without the tools service has no agent-facing trigger; the
    // flows can still be started from the panel. Losing the tool must not take
    // the plugin down.
    return () => {}
  }
  return () => {
    try {
      dispose()
    } catch { /* ignore */ }
  }
}
