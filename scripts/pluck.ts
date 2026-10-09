const baseUrl = process.env.PLUCK_URL;
const token = process.env.PLUCK_TOKEN;
const [command, argument] = process.argv.slice(2);

if (!baseUrl || !token) {
  usage("PLUCK_URL and PLUCK_TOKEN are required");
}

const routes: Record<string, string> = {
  jobs: "/api/jobs",
  status: argument ? `/api/jobs/${encodeURIComponent(argument)}` : "/api/jobs",
  show: argument ? `/api/jobs/${encodeURIComponent(argument)}` : "",
  retry: argument ? `/api/jobs/${encodeURIComponent(argument)}/retry` : "",
};
const path = routes[command ?? ""];
if (!path) usage("usage: npm run pluck -- jobs | status <job-id> | show <job-id> | retry <job-id>");

const response = await fetch(`${baseUrl!.replace(/\/$/, "")}${path}`, {
  method: command === "retry" ? "POST" : "GET",
  headers: { Authorization: `Bearer ${token}` },
});
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}
