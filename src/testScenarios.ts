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
  addResourceLinkRendering(config);
  addMultiplePermissionPrompts(config);
  addSessionCommitScenario(config);
  addResumeSessionScenario(config);

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
    },
    notifications: {
      permissionAllowed: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
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
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "diff_tool_call_1",
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

function addResourceLinkRendering(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "show resource link",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: "status.md",
              title: "Project Status",
              uri: "file:///workspace/status.md",
              description: "Latest project status",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource",
              resource: {
                uri: "file:///workspace/notes.md",
                text: "Meeting notes: action items and owners",
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
              text: "Shared the latest project resources.",
            },
          },
        },
      ],
    },
  });
}

function addMultiplePermissionPrompts(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "multi permission",
    permissions: [
      {
        title: "Allow access to telemetry endpoint?",
        rawInput: {
          command: ["/bin/sh", "-c", "curl https://api.example.com/telemetry"],
        },
      },
      {
        title: "Allow access to incident report?",
        rawInput: {
          command: [
            "/bin/sh",
            "-c",
            "curl https://api.example.com/incidents/latest",
          ],
        },
      },
    ],
    notificationSteps: [
      {
        permissionAllowed: [
          {
            sessionId: "test-session-id",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Telemetry access granted.",
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
                text: "Telemetry access denied.",
              },
            },
          },
        ],
      },
      {
        permissionAllowed: [
          {
            sessionId: "test-session-id",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Incident access granted.",
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
                text: "Incident access denied.",
              },
            },
          },
        ],
      },
    ],
  });
}

function addSessionCommitScenario(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "commit session",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session committed and ready to resume.",
            },
          },
        },
      ],
    },
  });
}
