import { AcpClient, AcpPermissionHandler } from "./acpClient";
import {
  createPreprogrammedAcpClient,
  PreprogrammedConfig,
} from "./preprogrammedAcpClient";

export function createTestAcpClientWithScenarios(
  permissionHandler: AcpPermissionHandler,
): AcpClient {
  const config: PreprogrammedConfig = {
    permissionHandler: permissionHandler,
    promptPrograms: [],
    session: {
      sessionId: "test-session-id",
      models: {
        availableModels: [
          {
            modelId: "gpt-4",
            name: "GPT-4",
          },
          {
            modelId: "gpt-3.5-turbo",
            name: "GPT-3.5 Turbo",
          },
        ],
        currentModelId: "gpt-4",
      },
      modes: {
        availableModes: [
          {
            id: "plan",
            name: "Plan",
          },
          {
            id: "build",
            name: "Build",
          },
        ],
        currentModeId: "plan",
      },
    },
    agentCapabilities: {
      loadSession: true,
    },
    sessionToResume: {
      sessionId: "test-session-id",
      turns: [],
      cwd: "",
      label: "Session to resume",
      models: {
        availableModels: [
          {
            modelId: "gpt-4",
            name: "GPT-4",
          },
          {
            modelId: "gpt-3.5-turbo",
            name: "GPT-3.5 Turbo",
          },
        ],
        currentModelId: "gpt-4",
      },
      modes: {
        availableModes: [
          {
            id: "plan",
            name: "Plan",
          },
          {
            id: "build",
            name: "Build",
          },
        ],
        currentModeId: "plan",
      },
    },
  };

  addThinkingOfJoke(config);
  addAskForPermissionAndGetWeather(config);
  addToolCallFailure(config);
  addToolCallSuccess(config);
  addToolCallDiffPreview(config);
  addPlanUpdateScenario(config);
  addResumeSessionScenario(config);
  addAskQuestionScenario(config);

  // create a new prompt which lists these scenarios when typed "list"
  config.promptPrograms?.push({
    promptText: "list",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Available scenarios:\n",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: config.promptPrograms
                .map((program) => `- ${program.promptText}`)
                .join("\n"),
            },
          },
        },
      ],
    },
  });

  return createPreprogrammedAcpClient(config);
}

function addThinkingOfJoke(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "tell joke",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "Thinking of a joke...",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Why did the scarecrow win an award? Because he was outstanding in his field!",
            },
          },
        },
      ],
    },
  });
}

function addAskForPermissionAndGetWeather(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "fetch weather",
    permission: {
      title: "Allow access to weather data?",
      rawInput: {
        command: [
          "/bin/sh",
          "-c",
          "curl https://api.weather.com/v3/wx/conditions/current",
        ],
      },
      toolCall: {
        toolCallId: "fetch_weather_tool_call_1",
        title: "Fetch Weather Data",
        kind: "fetch",
        rawInput: {
          command: [
            "/bin/sh",
            "-c",
            "curl https://api.weather.com/v3/wx/conditions/current",
          ],
        },
        status: "pending",
      },
    },
    notifications: {
      permissionAllowed: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch_weather_tool_call_1",
            title: "Fetch Weather Data",
            kind: "fetch",
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fetch_weather_tool_call_1",
            title: "Fetch Weather Data",
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fetch_weather_tool_call_1",
            content: [
              {
                type: "content",
                content: {
                  text: "72°F, Clear Skies",
                  type: "text",
                },
              },
            ],
            rawOutput: {
              output: "Current temperature is 72°F with clear skies.",
            },
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "completed",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "The current temperature is 72°F with clear skies.",
            },
          },
        },
      ],
      permissionDenied: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "I was unable to fetch the weather data because permission was denied.",
            },
          },
        },
      ],
    },
  });
}

function addToolCallFailure(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "run python",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "python_tool_call_1",
            kind: "execute",
            title: "Run Python Script",
            rawInput: {
              command: ["python3", "-c", "print('Hello World')"],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "python_tool_call_1",
            rawOutput: {
              command: ["python3", "-c", "print('Hello World')"],
              formatted_output:
                'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nSyntaxError: invalid syntax',
            },
            status: "failed",
          },
        },
      ],
    },
  });
}

function addToolCallSuccess(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "run ls",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "ls_tool_call_1",
            title: "List Directory",
            kind: "execute",
            rawInput: {
              command: ["ls", "-la"],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "ls_tool_call_1",
            rawOutput: {
              command: ["ls", "-la"],
              aggregated_output:
                "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
              formatted_output:
                "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
                },
              },
            ],
            status: "completed",
          },
        },
      ],
    },
  });
}

function addToolCallDiffPreview(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "update file",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "diff_tool_call_1",
            title: "Update src/index.ts",
            rawInput: {
              command: ["apply_patch", "src/index.ts"],
            },
            kind: "edit",
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "diff_tool_call_1",
            kind: "edit",
            content: [
              {
                type: "diff",
                path: "src/index.ts",
                oldText: "export const value = 1;\n",
                newText:
                  "export const value = 1;\nexport const greeting = 'hello world';\n",
              },
            ],
            status: "completed",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "I've added a new greeting export to src/index.ts.",
            },
          },
        },
      ],
    },
  });
}

function addPlanUpdateScenario(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "show plan",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Drafting a plan for the request...",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Review current requirements",
                priority: "high",
                status: "completed",
              },
              {
                content: "Identify impacted modules",
                priority: "medium",
                status: "in_progress",
              },
              {
                content: "Draft implementation steps",
                priority: "medium",
                status: "pending",
              },
              {
                content: "Validate with a quick test run",
                priority: "low",
                status: "pending",
              },
            ],
          },
        },
      ],
    },
  });
}

function addResumeSessionScenario(config: PreprogrammedConfig) {
  config.sessionToResume.turns = [
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "User: update release plan",
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "resource",
          resource: {
            uri: "file:///workspace/release-plan.md",
            text: "release-plan.md",
          },
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Understood, preparing the updated plan.",
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Reviewing current release checklist...",
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "plan",
        entries: [
          {
            content: "Collect performance metrics",
            priority: "high",
            status: "completed",
          },
          {
            content: "Draft release notes",
            priority: "medium",
            status: "pending",
          },
        ],
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "gather_telemetry",
        title: "Gather Telemetry Data",
        rawInput: {
          command: ["webfetch https://internal.api/telemetry"],
        },
        status: "in_progress",
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "gather_telemetry",
        status: "completed",
        rawInput: {
          command: ["webfetch https://internal.api/telemetry"],
        },
        rawOutput: {
          aggregated_output:
            "Telemetry data collected: CPU usage, Memory usage, Disk I/O",
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Telemetry data collected: CPU usage, Memory usage, Disk I/O",
            },
          },
        ],
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "release_plan_diff",
        title: "Update release-plan.md",
        rawInput: {
          command: ["apply_patch", "release-plan.md"],
        },
        status: "in_progress",
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "release_plan_diff",
        status: "completed",
        rawOutput: {
          aggregated_output: "Patched release-plan.md",
        },
        content: [
          {
            type: "diff",
            path: "release-plan.md",
            oldText: "## Release Notes\n- Initial draft\n",
            newText:
              "## Release Notes\n- Initial draft\n- Added telemetry milestones\n",
          },
        ],
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource_link",
          name: "release-plan.md",
          title: "release-plan.md",
          uri: "file:///workspace/release-plan.md",
          description: "Updated plan",
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Release plan updated with telemetry milestones.",
        },
      },
    },
  ];
}

function addAskQuestionScenario(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "ask question",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "I need to ask you a question to proceed.",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "question_tool_call_1",
            title: "question",
            status: "in_progress",
            kind: "other",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "question_tool_call_1",
            status: "in_progress",
            kind: "other",
            title: "question",
            rawInput: {
              questions: [
                {
                  header: "Choose option",
                  question: "Which approach should I use?",
                  multiSelect: false,
                  options: [
                    {
                      label: "Option A",
                      description: "Proceed with the standard flow",
                    },
                    {
                      label: "Option B",
                      description: "Use the alternative flow",
                    },
                    {
                      label: "Option C",
                      description: "Pause and ask again later",
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
  });

  // Add response handlers for each option
  const optionAResponse = [
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "question_tool_call_1",
        status: "completed" as const,
        rawOutput: {
          answers: {
            "0": "Option A",
          },
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: {
          type: "text" as const,
          text: "Great! I'll proceed with the standard flow as you selected Option A.",
        },
      },
    },
  ];

  const optionBResponse = [
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "question_tool_call_1",
        status: "completed" as const,
        rawOutput: {
          answers: {
            "0": "Option B",
          },
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: {
          type: "text" as const,
          text: "Understood! I'll use the alternative flow as you selected Option B.",
        },
      },
    },
  ];

  const optionCResponse = [
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "question_tool_call_1",
        status: "completed" as const,
        rawOutput: {
          answers: {
            "0": "Option C",
          },
        },
      },
    },
    {
      sessionId: "test-session-id",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: {
          type: "text" as const,
          text: "No problem! I'll pause here and we can continue later as you selected Option C.",
        },
      },
    },
  ];

  // Register answer handlers
  config.promptPrograms?.push({
    promptText: "answer:Option A",
    notifications: {
      prompt: optionAResponse,
    },
    response: {
      stopReason: "end_turn",
    },
  });

  config.promptPrograms?.push({
    promptText: "answer:Option B",
    notifications: {
      prompt: optionBResponse,
    },
    response: {
      stopReason: "end_turn",
    },
  });

  config.promptPrograms?.push({
    promptText: "answer:Option C",
    notifications: {
      prompt: optionCResponse,
    },
    response: {
      stopReason: "end_turn",
    },
  });
}
