package app.backend;

import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Controller
@RestController
@RequestMapping("/api")
public class SessionController {
    private final SimpMessagingTemplate messagingTemplate;
    private final Map<String, Map<String, Map<String, String>>> sessions = new ConcurrentHashMap<>();
    private final Map<String, String> connectionToSession = new ConcurrentHashMap<>();
    private final Map<String, String> connectionToUser = new ConcurrentHashMap<>();
    private final Map<String, String> contents = new ConcurrentHashMap<>();
    private final Map<String, String> languages = new ConcurrentHashMap<>();

    public SessionController(SimpMessagingTemplate messagingTemplate) {
        this.messagingTemplate = messagingTemplate;
    }

    record ContentMsg(String sessionId, String value, String userId) {}
    record LangMsg(String sessionId, String language, String userId) {}
    record JoinMsg(String sessionId, String name, String color, String userId) {}
    record ParticipantsReq(String sessionId) {}
    record CursorMsg(String sessionId, String userId, String name, String color, Map<String, Object> position, Map<String, Object> selection) {}

    @MessageMapping("/content")
    public void content(ContentMsg msg) {
        contents.put(msg.sessionId(), msg.value());
        messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                "type", "content",
                "value", msg.value(),
                "userId", msg.userId()
        ));
    }

    @MessageMapping("/language")
    public void language(LangMsg msg) {
        languages.put(msg.sessionId(), msg.language());
        messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                "type", "language",
                "language", msg.language(),
                "userId", msg.userId()
        ));
    }

    @MessageMapping("/cursor")
    public void cursor(CursorMsg msg) {
        messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                "type", "cursor",
                "userId", msg.userId(),
                "name", msg.name(),
                "color", msg.color(),
                "position", msg.position(),
                "selection", msg.selection()
        ));
    }

    @MessageMapping("/join")
    public void join(JoinMsg msg, org.springframework.messaging.Message<?> message) {
        var sha = StompHeaderAccessor.wrap(message);
        String simpSessionId = sha.getSessionId();
        if (simpSessionId != null) {
            connectionToSession.put(simpSessionId, msg.sessionId());
            connectionToUser.put(simpSessionId, msg.userId());
        }
        
        boolean isFirstUser = !sessions.containsKey(msg.sessionId());
        
        sessions.computeIfAbsent(msg.sessionId(), k -> new ConcurrentHashMap<>())
                .put(msg.userId(), Map.of("userId", msg.userId(), "name", msg.name(), "color", msg.color()));
        messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                "type", "join",
                "name", msg.name(),
                "color", msg.color(),
                "userId", msg.userId()
        ));
        
        // Send session initialization status
        messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                "type", "session_init",
                "isNew", isFirstUser,
                "userId", msg.userId()
        ));
        
        String currentLang = languages.get(msg.sessionId());
        String currentContent = contents.get(msg.sessionId());
        if (currentLang != null) {
            messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                    "type", "language",
                    "language", currentLang,
                    "userId", "server"
            ));
        }
        if (currentContent != null) {
            messagingTemplate.convertAndSend("/topic/session." + msg.sessionId(), Map.of(
                    "type", "content",
                    "value", currentContent,
                    "userId", "server"
            ));
        }
    }

    @MessageMapping("/participants")
    public void participants(ParticipantsReq req, org.springframework.messaging.Message<?> message) {
        var list = sessions.getOrDefault(req.sessionId(), Map.of()).values();
        // broadcast participants list
        messagingTemplate.convertAndSend("/topic/session." + req.sessionId(), Map.of(
                "type", "participants",
                "list", list.toArray()
        ));
        // also send current content and language only to the requesting session
        var sha = StompHeaderAccessor.wrap(message);
        String simpSessionId = sha.getSessionId();
        if (simpSessionId != null) {
            var header = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
            header.setSessionId(simpSessionId);
            header.setLeaveMutable(true);
            String currentLang = languages.get(req.sessionId());
            String currentContent = contents.get(req.sessionId());
            if (currentLang != null) {
                messagingTemplate.convertAndSendToUser(simpSessionId, "/queue/session." + req.sessionId(), Map.of(
                        "type", "language",
                        "language", currentLang,
                        "userId", "server"
                ), header.getMessageHeaders());
            }
            if (currentContent != null) {
                messagingTemplate.convertAndSendToUser(simpSessionId, "/queue/session." + req.sessionId(), Map.of(
                        "type", "content",
                        "value", currentContent,
                        "userId", "server"
                ), header.getMessageHeaders());
            }
        }
    }

    @EventListener
    public void handleDisconnect(SessionDisconnectEvent event) {
        StompHeaderAccessor sha = StompHeaderAccessor.wrap(event.getMessage());
        String simpSessionId = sha.getSessionId();
        String sessionId = connectionToSession.remove(simpSessionId);
        String userId = connectionToUser.remove(simpSessionId);
        if (sessionId != null && userId != null) {
            var map = sessions.getOrDefault(sessionId, new ConcurrentHashMap<>());
            var user = map.remove(userId);
            if (user != null) {
                messagingTemplate.convertAndSend("/topic/session." + sessionId, Map.of(
                        "type", "leave",
                        "userId", userId
                ));
            }
        }
    }
}
