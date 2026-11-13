package dshbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Shared plumbing for the DSH actions: where the Host lives, which sessions are
 * alive, and how a request is posted.
 *
 * <p>The DSH web port changes on every launch, so the Host publishes its origin
 * to {@code ~/.dsh/idea-bridge.json}; every action reads that file first.
 */
final class Bridge {

    static final String NOTIFICATION_GROUP = "dsh.bridge";
    private static final String PROBE_FILE = "idea-bridge.json";

    // The DSH web server closes the socket on an h2c upgrade attempt, which
    // surfaces as "HTTP/1.1 header parser received no bytes". Pin HTTP/1.1.
    static final HttpClient CLIENT = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(3))
            .build();

    private Bridge() {
    }

    static String readOrigin() throws Exception {
        Path probe = Path.of(System.getProperty("user.home"), ".dsh", PROBE_FILE);
        if (!Files.isRegularFile(probe)) {
            throw new IllegalStateException("找不到 " + probe + "，请先启动 DSH。");
        }
        JsonObject root = JsonParser.parseString(Files.readString(probe, StandardCharsets.UTF_8)).getAsJsonObject();
        if (!root.has("origin")) {
            throw new IllegalStateException(probe + " 里没有 origin 字段。");
        }
        return root.get("origin").getAsString();
    }

    static List<Session> fetchSessions(String origin) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(origin + "/dsh-idea/sessions"))
                .timeout(Duration.ofSeconds(5))
                .GET()
                .build();
        HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new IllegalStateException("DSH 返回 " + response.statusCode());
        }
        JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
        JsonArray array = root.getAsJsonArray("sessions");
        List<Session> sessions = new ArrayList<>();
        if (array != null) {
            for (var element : array) {
                JsonObject row = element.getAsJsonObject();
                String id = row.has("id") ? row.get("id").getAsString() : "";
                String cwd = row.has("cwd") && !row.get("cwd").isJsonNull() ? row.get("cwd").getAsString() : "";
                String title = row.has("title") && !row.get("title").isJsonNull() ? row.get("title").getAsString() : "";
                if (!id.isEmpty()) {
                    sessions.add(new Session(id, title, cwd));
                }
            }
        }
        return sessions;
    }

    /** Prefers the session rooted at the open project; asks when that is ambiguous. */
    static Session chooseSession(Project project, List<Session> sessions, String basePath, String purpose) {
        if (sessions.isEmpty()) {
            notify(project, "发送到 DSH 失败", "当前没有活着的 DSH 会话，请先在 DSH 里打开一个会话。",
                    NotificationType.ERROR);
            return null;
        }
        if (basePath != null) {
            String normalized = basePath.replaceAll("/+$", "");
            List<Session> matching = new ArrayList<>();
            for (Session session : sessions) {
                if (session.cwd.replaceAll("/+$", "").equals(normalized)) {
                    matching.add(session);
                }
            }
            if (matching.size() == 1) {
                return matching.get(0);
            }
            if (matching.size() > 1) {
                return ask(project, matching, purpose);
            }
        }
        return ask(project, sessions, purpose);
    }

    private static Session ask(Project project, List<Session> sessions, String purpose) {
        String[] values = new String[sessions.size()];
        for (int i = 0; i < sessions.size(); i++) {
            values[i] = label(sessions.get(i));
        }
        // The caller runs on a pooled thread; dialogs must be shown on the EDT.
        String[] picked = new String[1];
        ApplicationManager.getApplication().invokeAndWait(() -> picked[0] = Messages.showEditableChooseDialog(
                purpose, "Send to DSH", Messages.getQuestionIcon(),
                values, values[0], null));
        if (picked[0] == null) {
            return null;
        }
        int index = Arrays.asList(values).indexOf(picked[0]);
        return index >= 0 ? sessions.get(index) : null;
    }

    /** Session title is what a person recognizes; the id stays a fallback. */
    static String label(Session session) {
        String head = session.title == null || session.title.isBlank() ? session.id : session.title;
        return session.cwd.isBlank() ? head : head + "  ·  " + session.cwd;
    }

    /** POST a JSON payload and return the parsed reply, refusing non-2xx answers. */
    static JsonObject post(String origin, String route, JsonObject payload) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(origin + route))
                .timeout(Duration.ofSeconds(10))
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload.toString(), StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new IllegalStateException(reasonOf(response));
        }
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    /** The Host explains refusals in `error`; surface that instead of a bare status. */
    private static String reasonOf(HttpResponse<String> response) {
        String fallback = "DSH 返回 " + response.statusCode();
        try {
            JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
            if (root.has("error") && !root.get("error").isJsonNull()) {
                return root.get("error").getAsString();
            }
        } catch (RuntimeException ignored) {
            // Not JSON; the status code is all we have.
        }
        return fallback;
    }

    static void notify(Project project, String title, String content, NotificationType type) {
        NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP)
                .createNotification(title, content, type)
                .notify(project);
    }

    record Session(String id, String title, String cwd) {
    }
}
