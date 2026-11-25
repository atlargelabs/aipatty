import { readFile } from "node:fs/promises";
import { HttpError, jsonBody, requireMethod, sendJson } from "../../http.ts";
import type { ConnectedApp, OpenApp } from "../app.ts";
import { GymInputError } from "./model.ts";
import { phonePage } from "./page.ts";
import { openGymStore } from "./store.ts";
import { instructions, openGymTools } from "./tools.ts";

export const gymApp: ConnectedApp = {
  id: "gym",
  title: "Gym",
  instructions,
  open({ dataDir }): OpenApp {
    const store = openGymStore(dataDir);
    try {
      const { tools, close } = openGymTools(store);
      return {
        tools,
        web: new URL("./web.ts", import.meta.url),
        close() {
          try { close(); } finally { store.close(); }
        },
        async handle(req, res, path) {
          if (path === "/" || path === "/phone.css" || path === "/phone.js") {
            requireMethod(req, res, "GET");
            const body = path === "/" ? phonePage : await readFile(new URL("." + path, import.meta.url));
            const type = path === "/" ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript";
            res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
            res.end(body);
            return;
          }
          if (path === "/api/overview") {
            requireMethod(req, res, "GET");
            sendJson(res, 200, store.overview());
            return;
          }
          try {
            if (path === "/api/last") {
              requireMethod(req, res, "GET");
              const { searchParams } = new URL(req.url ?? "/", "http://localhost");
              sendJson(res, 200, store.lastSession(searchParams.get("exercise")));
              return;
            }
            const match = /^\/api\/workouts\/([^/]+)$/.exec(path);
            if (!match) throw new HttpError(404, "Gym page not found");
            requireMethod(req, res, "GET", "PUT", "DELETE");
            const id = match[1];
            if (req.method === "GET") {
              const workout = store.workout(id);
              if (!workout) throw new HttpError(404, "Workout not found. Reload Gym to refresh the list.");
              sendJson(res, 200, workout);
            } else if (req.method === "DELETE") {
              sendJson(res, 200, store.deleteWorkout(id));
            } else {
              const body = await jsonBody(req);
              if (body.id !== undefined && body.id !== id) throw new GymInputError("Workout ID must match the URL.");
              sendJson(res, 200, store.saveWorkout({ ...body, id }));
            }
          } catch (error) {
            if (error instanceof GymInputError) throw new HttpError(400, error.message);
            throw error;
          }
        },
      };
    } catch (error) {
      store.close();
      throw error;
    }
  },
};
