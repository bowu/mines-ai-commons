import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AgentsPage } from "./components/AgentsPage";
import { AppSidebar } from "./components/AppSidebar";
import { SkillsPage } from "./components/SkillsPage";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar";
import { AgentsProvider } from "./contexts/AgentsContext";
import { AuthProvider } from "./contexts/AuthContext";

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AgentsProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0">
              <div className="flex h-screen flex-col overflow-hidden">
                <div className="flex items-center border-b bg-background px-2 py-1 md:hidden">
                  <SidebarTrigger />
                </div>
                <main className="min-w-0 flex-1 overflow-hidden">
                  <Routes>
                    <Route
                      path="/"
                      element={<Navigate to="/agents" replace />}
                    />
                    <Route path="/agents/*" element={<AgentsPage />} />
                    <Route path="/skills" element={<SkillsPage />} />
                    <Route
                      path="*"
                      element={<Navigate to="/agents" replace />}
                    />
                  </Routes>
                </main>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </AgentsProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
