'''
Author: your name
Date: 2024-05-16 19:19:13
LastEditTime: 2024-05-21 16:14:01
LastEditors: 8svbj4mdtuhd3-0
Description: In User Settings Edit
FilePath: /Product_Optimization_v2/utils/log_utils.py
'''

import datetime
import logging
from concurrent_log_handler import ConcurrentRotatingFileHandler
import os
import sys

LOGDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")


def _patch_openai_httpx_del():
    """Monkey-patch openai httpx client __del__ to suppress AttributeError during GC.

    OpenAI SDK 的 SyncHttpxClientWrapper.__del__ 在垃圾回收时访问 self._state，
    但该属性可能已被 GC 清除，导致 AttributeError 刷屏。直接 patch __del__ 从根源解决。
    """
    try:
        from openai._base_client import SyncHttpxClientWrapper, AsyncHttpxClientWrapper
        for cls in (SyncHttpxClientWrapper, AsyncHttpxClientWrapper):
            if hasattr(cls, '__del__'):
                original = cls.__del__
                def safe_del(self, _orig=original):
                    try:
                        _orig(self)
                    except Exception:
                        pass
                cls.__del__ = safe_del
    except (ImportError, AttributeError):
        pass

_patch_openai_httpx_del()

server_error_msg = "**NETWORK ERROR DUE TO HIGH TRAFFIC. PLEASE REGENERATE OR REFRESH THIS PAGE.**"
moderation_msg = "YOUR INPUT VIOLATES OUR CONTENT MODERATION GUIDELINES. PLEASE TRY AGAIN."

# 标记 stdout/stderr 重定向是否已完成，避免多次覆盖
_stdio_redirected = False

def build_logger(logger_name, logger_filename):
    global _stdio_redirected

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 设置根记录器的格式（只执行一次）
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO)
    logging.getLogger().handlers[0].setFormatter(formatter)

    # 重定向 stdout 和 stderr 到记录器（只执行一次，避免后续 logger 覆盖）
    if not _stdio_redirected:
        stdout_logger = logging.getLogger("stdout")
        stdout_logger.setLevel(logging.INFO)
        sys.stdout = StreamToLogger(stdout_logger, logging.INFO)

        stderr_logger = logging.getLogger("stderr")
        stderr_logger.setLevel(logging.ERROR)
        sys.stderr = StreamToLogger(stderr_logger, logging.ERROR)

        _stdio_redirected = True

    # 获取记录器
    logger = logging.getLogger(logger_name)
    logger.setLevel(logging.INFO)

    # 添加并发文件处理程序
    os.makedirs(LOGDIR, exist_ok=True)
    filename = os.path.join(LOGDIR, logger_filename)
    file_handler = ConcurrentRotatingFileHandler(
        filename, maxBytes=1024 * 1024 * 10,  # 10MB per file
        backupCount=1,  # Keep 10 log files
        encoding='UTF-8'
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger

class StreamToLogger:

    def __init__(self, logger, log_level=logging.INFO):
        self.logger = logger
        self.log_level = log_level
        self.stream = sys.stderr  # 或 sys.stdout

    def write(self, buf):
        for line in buf.rstrip().splitlines():
            msg = line.rstrip()
            if msg:
                self.logger.log(self.log_level, msg)

    def flush(self):
        try:
            self.stream.flush()
        except Exception:
            pass

    def fileno(self):
        return self.stream.fileno()

    def __getattr__(self, attr):
        return getattr(self.stream, attr)