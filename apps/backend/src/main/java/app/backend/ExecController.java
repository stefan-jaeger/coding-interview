package app.backend;

import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Source;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.beans.factory.annotation.Value;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

@RestController
@RequestMapping("/api")
public class ExecController {
    private final org.springframework.messaging.simp.SimpMessagingTemplate messagingTemplate;
    private final int maxExecSeconds;

    public ExecController(org.springframework.messaging.simp.SimpMessagingTemplate messagingTemplate, @Value("${exec.maxSeconds:10}") int maxExecSeconds) {
        this.messagingTemplate = messagingTemplate;
        this.maxExecSeconds = maxExecSeconds;
    }

    record ExecReq(String sessionId, String language, String code) {}
    record ExecRes(String output, String error) {}

    @PostMapping(value = "/exec", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ExecRes exec(@RequestBody ExecReq req) throws Exception {
        messagingTemplate.convertAndSend("/topic/session." + req.sessionId(), java.util.Map.of(
                "type", "exec_start"
        ));
        ExecRes res = switch (req.language()) {
            case "javascript" -> runJs(req.code());
            case "typescript" -> runTs(req.code());
            case "java" -> runJava(req.code());
            default -> new ExecRes("", "Unsupported language");
        };
        messagingTemplate.convertAndSend("/topic/session." + req.sessionId(), java.util.Map.of(
                "type", "output",
                "output", res.output(),
                "error", res.error()
        ));
        return res;
    }

    private ExecRes runJs(String code) throws Exception {
        Path dir = Files.createTempDirectory("exec-node");
        try {
            Path file = dir.resolve("main.js");
            Files.writeString(file, code, StandardCharsets.UTF_8);
            return runProcess(List.of("node", file.toString()), dir);
        } finally { deleteDir(dir); }
    }

    private ExecRes runJava(String code) throws Exception {
        Path dir = Files.createTempDirectory("exec-java");
        try {
            Path file = dir.resolve("Main.java");
            Files.writeString(file, code, StandardCharsets.UTF_8);
            ExecRes compile = runProcess(List.of("javac", file.toString()), dir);
            if (compile.error != null && !compile.error.isEmpty()) return compile;
            return runProcess(List.of("java", "-cp", dir.toString(), "Main"), dir);
        } finally { deleteDir(dir); }
    }

    private ExecRes runTs(String code) throws Exception {
        Path dir = Files.createTempDirectory("exec-ts");
        try {
            Path tsconfig = dir.resolve("tsconfig.json");
            String tsconfigJson = "{\n" +
                    "  \"compilerOptions\": {\n" +
                    "    \"target\": \"ES2020\",\n" +
                    "    \"module\": \"commonjs\",\n" +
                    "    \"strict\": true,\n" +
                    "    \"esModuleInterop\": true,\n" +
                    "    \"skipLibCheck\": true,\n" +
                    "    \"rootDir\": \".\",\n" +
                    "    \"outDir\": \"out\"\n" +
                    "  },\n" +
                    "  \"include\": [\"main.ts\"]\n" +
                    "}";
            Files.writeString(tsconfig, tsconfigJson, StandardCharsets.UTF_8);
            Path file = dir.resolve("main.ts");
            Files.writeString(file, code, StandardCharsets.UTF_8);

            // First run a type-check only to surface TypeScript errors (syntax and type errors)
            ExecRes typecheck = runProcess(List.of("npx", "--yes", "-p", "typescript", "tsc", "--noEmit", "-p", dir.toString(), "--pretty", "false"), dir);
            if (typecheck.error != null && !typecheck.error.isEmpty()) {
                return new ExecRes("", sanitizePathOutput(typecheck.error, dir));
            }
            if (typecheck.output != null && !typecheck.output.isEmpty()) {
                return new ExecRes("", sanitizePathOutput(typecheck.output, dir));
            }

            // Then compile to JS
            ExecRes compile = runProcess(List.of("npx", "--yes", "-p", "typescript", "tsc", "-p", dir.toString(), "--pretty", "false"), dir);
            if (compile.error != null && !compile.error.isEmpty()) {
                return new ExecRes("", compile.error);
            }
            if (compile.output != null && !compile.output.isEmpty()) {
                // tsc may emit warnings to stdout
                // treat any stdout as potential messages
            }
            Path js = dir.resolve("out").resolve("main.js");
            if (!Files.exists(js)) {
                String err = (compile.error != null && !compile.error.isEmpty()) ? compile.error : compile.output();
                if (err == null || err.isEmpty()) err = "TypeScript compilation produced no output";
                return new ExecRes("", err);
            }
            return runProcess(List.of("node", js.toString()), dir);
        } finally { deleteDir(dir); }
    }

    private ExecRes runProcess(List<String> cmd, Path dir) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(dir.toFile());
        Process p = pb.start();
        ExecutorService es = Executors.newFixedThreadPool(2);
        try {
            Future<String> stdoutF = es.submit(() -> new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            Future<String> stderrF = es.submit(() -> new String(p.getErrorStream().readAllBytes(), StandardCharsets.UTF_8));
            boolean finished = p.waitFor(maxExecSeconds, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                stdoutF.cancel(true);
                stderrF.cancel(true);
                return new ExecRes("", "Execution exceeded maximum execution time.");
            }
            String stdout = "";
            String stderr = "";
            try {
                stdout = stdoutF.get(Math.max(1, Math.min(2, maxExecSeconds)), TimeUnit.SECONDS);
            } catch (TimeoutException | CancellationException ex) {
                stdout = "";
            }
            try {
                stderr = stderrF.get(Math.max(1, Math.min(2, maxExecSeconds)), TimeUnit.SECONDS);
            } catch (TimeoutException | CancellationException ex) {
                stderr = "";
            }
            es.shutdownNow();
            String execDir = dir.toAbsolutePath().toString();
            if (p.exitValue() != 0 && (stderr != null && !stderr.isEmpty())) {
                String err = stderr.replace(execDir + "/", "");
                err = err.replace("/private", "");
                return new ExecRes("", err);
            }
            String out = stdout.replace(execDir + "/", "");
            out = out.replace("/private", "");
            return new ExecRes(out, "");
        } finally {
            es.shutdownNow();
        }
    }

    private String sanitizePathOutput(String s, Path dir) {
        if (s == null) return null;
        String out = s;
        try {
            String d = dir.toAbsolutePath().toString();
            // normalize separators
            out = out.replace(d + "/", "");
            out = out.replace(d + "\\\\", "");
            out = out.replace("/private", "");
        } catch (Exception ignored) {}
        // collapse sequences like ../../../../main.ts or ..\\..\\main.ts to just main.ts
        out = out.replaceAll("(\\.\\\\/)+main\\.ts", "main.ts");
        out = out.replaceAll("(\\.\\\\\\\\)+main\\.ts", "main.ts");
        // also remove any remaining long relative paths that end with main.ts
        out = out.replaceAll("[^\\n\\r]*main\\.ts", "main.ts");
        return out;
    }

    private void deleteDir(Path dir) {
        try { Files.walk(dir).sorted(Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (IOException ignored) {} }); } catch (IOException ignored) {}
    }
}
