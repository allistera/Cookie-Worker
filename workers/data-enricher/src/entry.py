from workers import WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def scheduled(self, controller, env, ctx):
        # fastmcp (via rich) draws randomness at import time, which the runtime
        # forbids in top-level scope during the deploy-time snapshot; importing
        # inside the handler runs in request context where entropy is allowed.
        import fastmcp

        print(f"hello world (fastmcp {fastmcp.__version__})")
