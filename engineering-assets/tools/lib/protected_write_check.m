function reason = protected_write_check(target, tool)
%PROTECTED_WRITE_CHECK  受保护路径写入判定 (MATLAB 侧) —— 与 lib/protected-write.cjs 对等
%
%   为什么要有 MATLAB 这一份:
%     file-protection-guard 是 PreToolUse hook, 只拦 Edit/Write/MultiEdit。
%     lib/protected-write.cjs 补上了**经 Bash 跑的 Node 工具**那一路。
%     但 golden 侧的 generate_vectors.m 之流是 **MATLAB**, 直接 fopen 写进
%     models/**/vectors/ —— 两道防线都够不着它。
%     2026-08-09 实测: 一次 generate_vectors(struct('nsym',32)) 改写了
%     models/comm/channel_est/vectors/ 下三个文件, 无令牌、无审计、无拦截。
%
%   与 .cjs 那份的关系: **同一份令牌文件、同一套消费语义、同一个审计账本**。
%   判定规则刻意不在此重新推导 —— 两份副本必然漂移, 改了一处忘另一处, 洞就从没改
%   的那处漏。此处只做 MATLAB 侧无法复用 Node 代码的那部分转译, 并在审计里标
%   via='matlab' 以便与 hook/tool 两路区分。
%
%   用法 (写入方在**每次实际写入前**恰好调一次):
%       why = protected_write_check(out_file, 'generate_vectors');
%       if ~isempty(why), error('protected_write:blocked', '%s', why); end
%
%   返回空串 = 放行 (且令牌已消费、审计已写); 非空 = 应跳过写入, 内容给人看。

    if nargin < 2, tool = ''; end
    reason = '';
    target_n = strrep(char(target), '\', '/');

    if ~is_protected(target_n)
        return;                                   % 不在受保护区, 放行且不入账
    end

    root = repo_root();
    approval_file = fullfile(root, 'var', 'audit', 'protected-write-approvals.json');

    [ok, why, token] = consume_approval(approval_file, target_n);
    if ~ok
        if isempty(why)
            reason = sprintf(['%s 落在受保护路径且无有效令牌 —— 未写入。' ...
                '请按 var/audit/protected-write-approvals.json 的令牌流程申请后重跑, ' ...
                '或改用 Edit 工具逐项修改(走 file-protection 门禁并留审计)。'], target_n);
        else
            reason = sprintf('%s 落在受保护路径, 令牌不可用 —— 未写入。%s', target_n, why);
        end
        return;
    end

    append_audit(fullfile(root, 'var', 'audit', 'protected-writes.jsonl'), ...
                 target_n, token, tool);
end

% =====================================================================
function tf = is_protected(p)
%IS_PROTECTED  与 lib/protected-write.cjs 的 PROTECTED_PATTERNS 一一对应
    pats = { '(^|/)matlab/', '(^|/)07_mat/', '(^|/)golden_model[^/]*/', ...
             '(^|/)engineering-assets/models/', '^models/' };
    tf = false;
    for k = 1:numel(pats)
        if ~isempty(regexpi(p, pats{k}, 'once')), tf = true; return; end
    end
end

% =====================================================================
function root = repo_root()
%REPO_ROOT  <root>/engineering-assets/tools/lib/ -> <root>
    root = fileparts(fileparts(fileparts(fileparts(mfilename('fullpath')))));
end

% =====================================================================
function [ok, why, token] = consume_approval(file, target)
%CONSUME_APPROVAL  语义与 .cjs 侧 consumeApproval 一致:
%   裁决级(scope) 扣 remainingWrites 扣光即移除; 逐文件(path) 命中即移除;
%   顺手清过期条目; reason 缺失即拒绝放行; 写不回去也拒绝 (免得变成长期开关)。
    ok = false; why = ''; token = struct();
    if ~isfile(file), return; end
    try
        list = jsondecode(fileread(file));
    catch
        return;
    end
    if isempty(list), return; end
    if ~iscell(list), list = num2cell(list(:)'); end

    now_ms = (datenum(datetime('now', 'TimeZone', 'UTC')) - datenum(1970,1,1)) * 86400e3;
    alive = {};
    for k = 1:numel(list)
        t = list{k};
        if isfield(t, 'expiresAt') && token_ms(t.expiresAt) > now_ms
            alive{end+1} = t; %#ok<AGROW>
        end
    end

    hit = 0;
    for k = 1:numel(alive)
        if token_hits(alive{k}, target), hit = k; break; end
    end
    if hit == 0
        if numel(alive) ~= numel(list), write_tokens(file, alive); end
        return;
    end

    token = alive{hit};
    if ~isfield(token, 'reason') || isempty(strtrim(char(token.reason)))
        why = '令牌缺少 reason —— 无理由的放行不可审计, 拒绝'; return;
    end
    if isfield(token, 'scope') && ischar(token.scope) || isstring(token.scope)
        if ~isfield(token, 'remainingWrites')
            why = '裁决级令牌缺少可用的 remainingWrites'; return;
        end
        rem = double(token.remainingWrites) - 1;
        if rem > 0
            alive{hit}.remainingWrites = rem;
        else
            alive(hit) = [];
        end
    else
        alive(hit) = [];
    end
    if ~write_tokens(file, alive)
        why = '令牌无法消费(文件不可写) —— 为避免它变成长期开关, 拒绝放行'; return;
    end
    ok = true;
end

% =====================================================================
function ms = token_ms(s)
    try
        ms = (datenum(datetime(char(s), 'InputFormat', 'yyyy-MM-dd''T''HH:mm:ss.SSSX', ...
              'TimeZone', 'UTC')) - datenum(1970,1,1)) * 86400e3;
    catch
        try
            ms = (datenum(datetime(char(s), 'InputFormat', 'yyyy-MM-dd''T''HH:mm:ssX', ...
                  'TimeZone', 'UTC')) - datenum(1970,1,1)) * 86400e3;
        catch
            ms = 0;
        end
    end
end

% =====================================================================
function tf = token_hits(t, target)
    tf = false;
    if isfield(t, 'path') && (ischar(t.path) || isstring(t.path))
        p = strrep(char(t.path), '\', '/');
        tf = strcmp(target, p) || (contains(p, '/') && endsWith(target, ['/' p]));
        return;
    end
    if isfield(t, 'scope') && (ischar(t.scope) || isstring(t.scope))
        s = lower(regexprep(strrep(char(t.scope), '\', '/'), '/+$', ''));
        if ~contains(s, '/'), return; end
        lo = lower(target);
        tf = startsWith(lo, [s '/']) || contains(lo, ['/' s '/']);
    end
end

% =====================================================================
function ok = write_tokens(file, alive)
    ok = false;
    try
        if isempty(alive)
            txt = '[]';
        else
            txt = jsonencode([alive{:}]);
        end
        fid = fopen(file, 'w');
        if fid < 0, return; end
        fprintf(fid, '%s\n', txt);
        fclose(fid);
        ok = true;
    catch
        ok = false;
    end
end

% =====================================================================
function append_audit(file, target, token, tool)
%APPEND_AUDIT  与 hook / .cjs 同一账本同一字段布局; via='matlab' 用于区分来路。
    try
        d = fileparts(file);
        if ~exist(d, 'dir'), mkdir(d); end
        rec = struct('ts', char(datetime('now', 'TimeZone', 'UTC', ...
                        'Format', 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''')), ...
                     'file', target, ...
                     'reason', char(token.reason), ...
                     'via', 'matlab');
        if isfield(token, 'basis'), rec.basis = token.basis; end
        if ~isempty(tool), rec.tool = char(tool); end
        fid = fopen(file, 'a');
        if fid < 0
            warning('protected_write_check:audit', '审计写入失败, 放行仍已发生: %s', target);
            return;
        end
        fprintf(fid, '%s\n', jsonencode(rec));
        fclose(fid);
    catch
        % 审计失败不改变已发生的放行, 但必须让人看见
        warning('protected_write_check:audit', '审计写入失败, 放行仍已发生: %s', target);
    end
end
