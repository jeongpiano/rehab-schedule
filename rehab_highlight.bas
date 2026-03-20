Attribute VB_Name = "RehabHighlight"
Option Explicit

Public mHighlightedName As String
Public mHighlightedCells As String

Public Sub HighlightPatient(ByVal patientName As String)
    Dim ws As Worksheet
    Dim cell As Range
    Dim cellNames As Variant
    Dim j As Integer
    Dim HL_COLOR As Long
    
    HL_COLOR = RGB(255, 235, 59)
    
    Call ClearHighlights
    
    mHighlightedName = patientName
    mHighlightedCells = ""
    
    Set ws = ActiveSheet
    
    For Each cell In ws.UsedRange
        If Trim(CStr(cell.Value)) <> "" Then
            cellNames = GetKoreanNames(CStr(cell.Value))
            For j = 0 To UBound(cellNames)
                If cellNames(j) = patientName Then
                    cell.Interior.Color = HL_COLOR
                    If mHighlightedCells = "" Then
                        mHighlightedCells = cell.Address
                    Else
                        mHighlightedCells = mHighlightedCells & "," & cell.Address
                    End If
                    Exit For
                End If
            Next j
        End If
    Next cell
    
    If mHighlightedCells <> "" Then
        Application.StatusBar = patientName & " 하이라이트 완료 (ESC=해제)"
    End If
    
    Application.OnKey "{ESCAPE}", "ClearHighlights"
End Sub

Public Sub ClearHighlights()
    Dim ws As Worksheet
    Dim addrs() As String
    Dim i As Integer
    
    If mHighlightedCells <> "" Then
        Set ws = ActiveSheet
        addrs = Split(mHighlightedCells, ",")
        For i = 0 To UBound(addrs)
            ws.Range(Trim(addrs(i))).Interior.ColorIndex = xlNone
        Next i
    End If
    
    mHighlightedName = ""
    mHighlightedCells = ""
    Application.StatusBar = False
    Application.OnKey "{ESCAPE}"
End Sub

Public Function GetKoreanNames(ByVal txt As String) As Variant
    Dim buf(30) As String
    Dim cnt As Integer
    Dim cur As String
    Dim i As Long
    Dim ch As String
    Dim cd As Long
    
    cnt = 0
    cur = ""
    
    For i = 1 To Len(txt)
        ch = Mid(txt, i, 1)
        cd = AscW(ch)
        If cd < 0 Then cd = cd + 65536
        
        If cd >= 44032 And cd <= 55203 Then
            cur = cur & ch
        Else
            If Len(cur) >= 2 Then
                buf(cnt) = cur
                cnt = cnt + 1
                If cnt > 30 Then Exit For
            End If
            cur = ""
        End If
    Next i
    
    If Len(cur) >= 2 And cnt <= 30 Then
        buf(cnt) = cur
        cnt = cnt + 1
    End If
    
    If cnt = 0 Then
        Dim r0(0) As String
        r0(0) = ""
        GetKoreanNames = r0
    Else
        Dim r1() As String
        ReDim r1(cnt - 1)
        Dim k As Integer
        For k = 0 To cnt - 1
            r1(k) = buf(k)
        Next k
        GetKoreanNames = r1
    End If
End Function
